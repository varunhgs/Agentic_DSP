# New Project Start: BW Metadata Extraction with bw-modeling-mcp

This document explains the first 3 detailed steps for starting a BW metadata extraction project using the `bw-modeling-mcp` repository.

It is focused on the exact code-level and platform-level setup required to connect to BW/4HANA, list `InfoArea` objects, and read `InfoObject` metadata using this project.

---

## Step 1: Prepare the environment and connect to BW

### 1.1 Platform requirements

- Node.js 22 or later
- TypeScript installed in the repository via `npm install` or `npm install typescript`
- The repo is an MCP server written in TypeScript and compiled to `dist/`

### 1.2 Install dependencies

From the repository root:

```powershell
npm install
```

This installs:
- `@modelcontextprotocol/sdk`
- `axios`
- `express`
- `fast-xml-parser`
- TypeScript types

### 1.3 Configure BW connection environment variables

This project loads BW connection settings from environment variables. Set these in your shell or `.env`-style environment.

Required variables for classic Basic Auth mode:

```powershell
$env:BW_URL = 'https://my-bw-system.example.com'
$env:BW_CLIENT = '001'
$env:BW_LANGUAGE = 'EN'
$env:BW_USER = 'MYBWUSER'
$env:BW_PASSWORD = 'MySecretPassword'
```

For BW Bridge / cookie-based auth mode, instead set:

```powershell
$env:BW_URL = 'https://my-bw-bridge.example.com'
$env:BW_COOKIE_FILE = 'C:\path\to\cookies.txt'
```

The code that reads these settings is in `src/bw-client.ts`:

```ts
export function createClientFromEnv(): BwClient {
  const active = currentClient();
  if (active) return active.freshSession();
  return clientFromEnvironment();
}
```

`clientFromEnvironment()` builds a `BwClient` from the environment and throws if `BW_URL` is missing.

### 1.4 Confirm connection to BW

The project uses the BW Modeling discovery endpoint to validate the backend. The entry point is the `BwClient` class in `src/bw-client.ts`.

A simple validation command is:

```powershell
npm run build
node dist/stdio.js
```

That starts the MCP server in stdio mode. In a separate script or a tool call, you can verify connectivity by calling `bw_list_contents` or a read function.

---

## Step 2: Discover the repository and list InfoAreas

### 2.1 Understand the repository tool

The tool `bw_list_contents` is implemented in `src/tools/repository.ts`.

Key function:

```ts
export async function bwListContents(client: BwClient, path: string): Promise<string> {
  const normalizedPath = path.toLowerCase().replace(/^\/+/, '').replace(/\/+$, '');
  const url = normalizedPath ? `${BASE}/${normalizedPath}` : BASE;
  const { body } = await client.get(url, 'application/atom+xml');
  const entries = parseAtomFeed(body);

  return JSON.stringify(
    {
      path: path || '/',
      count: entries.length,
      entries,
    },
    null,
    2
  );
}
```

This tool returns repository entries under the top-level `repo/infoproviderstructure` path.

### 2.2 Use `bw_list_contents("/")` to list InfoAreas

At the code level, the root path lists all InfoAreas.

Example call in a custom script:

```ts
import { createClientFromEnv } from './src/bw-client.js';
import { bwListContents } from './src/tools/repository.js';

async function listInfoAreas() {
  const client = createClientFromEnv();
  const result = await bwListContents(client, '/');
  console.log(result);
}

listInfoAreas().catch(console.error);
```

The output contains entries with fields like:
- `name`
- `description`
- `object_type`
- `status`
- `children_path`

Filter for entries where `object_type === 'AREA'`.

### 2.3 Understand repository path syntax

The repository paths in this project use these conventions:

- `/` or `` for all InfoAreas
- `area/{INFOAREA}` for an InfoArea folder
- `area/{INFOAREA}/iobj` for InfoObjects in that InfoArea

This is documented in `src/index.ts` tool metadata for `bw_list_contents`.

---

## Step 3: Read InfoArea and InfoObject metadata

### 3.1 Read InfoArea metadata

The InfoArea read tool is in `src/tools/infoarea.ts`.

Important function:

```ts
export async function bwGetInfoarea(client: BwClient, name: string): Promise<string> {
  const nameLower = name.toLowerCase();
  const result = await client.get(`/sap/bw/modeling/area/${nameLower}`, MEDIA_TYPES['area']);
  const body = result.body;

  try {
    const parsed = JSON.parse(body);

    const infoAreaName: string = parsed['name'] ?? name.toUpperCase();
    const label: string = parsed['endUserTexts']?.['label'] ?? parsed['descriptions']?.['label'] ?? parsed['label'] ?? '';
    const parentArea: string | null = parsed['tlogoProperties']?.['infoArea'] ?? parsed['parentInfoArea'] ?? null;
    const objectStatus: string = parsed['tlogoProperties']?.['adtcore:version'] ?? parsed['tlogoProperties']?.['objectStatus'] ?? parsed['objectStatus'] ?? '';

    return JSON.stringify({ name: infoAreaName, label, parent_area: parentArea || null, object_status: objectStatus }, null, 2);
  } catch {
    return JSON.stringify({ raw: body });
  }
}
```

Use the area name from `bw_list_contents` and pass it to `bw_get_infoarea`.

Example:

```ts
import { bwGetInfoarea } from './src/tools/infoarea.js';
import { createClientFromEnv } from './src/bw-client.js';

async function readInfoArea(name: string) {
  const client = createClientFromEnv();
  const metadata = await bwGetInfoarea(client, name);
  console.log(metadata);
}

readInfoArea('MYAREA').catch(console.error);
```

### 3.2 Read InfoObject metadata

The InfoObject read tool is in `src/tools/infoobject.ts`.

Key code:

```ts
export async function bwGetInfoObject(
  client: BwClient,
  infoObjectName: string
): Promise<string> {
  const accept = MEDIA_TYPES['iobj'];
  const path = `/sap/bw/modeling/iobj/${infoObjectName.toLowerCase()}/m`;
  const result = await freshRead(path, accept);
  const status = result.headers['object_status'] ?? result.headers['OBJECT_STATUS'] ?? 'unknown';
  return `InfoObject: ${infoObjectName.toUpperCase()}\nStatus: ${status}\n\n${result.body}`;
}
```

Notice `freshRead()` is used to ensure a new BW session and avoid stale model state.

### 3.3 List InfoObjects inside an InfoArea

Use `bw_list_contents('area/{INFOAREA}/iobj')`.

Example:

```ts
import { createClientFromEnv } from './src/bw-client.js';
import { bwListContents } from './src/tools/repository.js';

async function listInfoObjects(areaName: string) {
  const client = createClientFromEnv();
  const path = `area/${areaName}/iobj`;
  const result = await bwListContents(client, path);
  console.log(result);
}

listInfoObjects('MYAREA').catch(console.error);
```

Then for each returned InfoObject name call `bwGetInfoObject(client, objectName)`.

### 3.4 Example crawler logic in code

A minimal first-step crawler in TypeScript:

```ts
import { createClientFromEnv } from './src/bw-client.js';
import { bwListContents } from './src/tools/repository.js';
import { bwGetInfoarea } from './src/tools/infoarea.js';
import { bwGetInfoObject } from './src/tools/infoobject.js';

async function run() {
  const client = createClientFromEnv();
  const areasJson = JSON.parse(await bwListContents(client, '/'));

  for (const entry of areasJson.entries) {
    if (entry.object_type !== 'AREA') continue;
    const areaName = entry.name;
    const areaMeta = JSON.parse(await bwGetInfoarea(client, areaName));
    console.log('InfoArea', areaMeta);

    const objectsJson = JSON.parse(await bwListContents(client, `area/${areaName}/iobj`));
    for (const objEntry of objectsJson.entries) {
      const infoObjectXml = await bwGetInfoObject(client, objEntry.name);
      console.log('InfoObject', objEntry.name, infoObjectXml.slice(0, 500));
    }
  }
}

run().catch(console.error);
```

### 3.5 Save the extracted metadata

Write the JSON and raw XML to disk so you have a stable extraction snapshot.

Example file output pattern:

- `output/info_areas.json`
- `output/info_area_{NAME}.json`
- `output/infoobject_{NAME}.xml`

Use the extracted metadata as the foundation for DSP mapping.

---

## Summary

The first 3 steps are:

1. **Prepare the environment and connect to BW**
   - install npm dependencies
   - set `BW_URL`, `BW_USER`, `BW_PASSWORD`, `BW_CLIENT`, `BW_LANGUAGE`
   - build the project and verify connectivity

2. **Discover the repository and list InfoAreas**
   - use `bw_list_contents('/')`
   - filter for `object_type === 'AREA'`
   - understand path conventions like `area/{INFOAREA}/iobj`

3. **Read InfoArea and InfoObject metadata**
   - call `bw_get_infoarea(name)`
   - call `bw_list_contents('area/{INFOAREA}/iobj')`
   - call `bw_get_infoobject(name)` for each InfoObject

These are the exact first steps to start a BW-to-DSP metadata extraction project using this repository.
