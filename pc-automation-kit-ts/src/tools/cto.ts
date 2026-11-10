import { BwClient } from '../bw-client.js';

// Extracted from bw-modeling-mcp src/tools/cto.ts — only bw_list_changeable_transports
// (bw_change_package was left out: it depends on the DataSource tools).

const CTO_MEDIA_TYPE = 'application/vnd.sap.bw.modeling.cto-v1_1_0+xml';

export interface ListChangeableTransportsArgs {
  ownOnly: boolean;
  modifiableOnly: boolean;
  includeObjects: boolean;
}

function ctoAttr(attrs: string, name: string): string {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';
}

/**
 * bw_list_changeable_transports — list transport requests via cto/check.
 * Endpoint, query params and response shape: see payloads/list_changeable_transports.md.
 */
export async function bwListChangeableTransports(
  client: BwClient,
  args: ListChangeableTransportsArgs
): Promise<string> {
  const path =
    `/sap/bw/modeling/cto/check?rddetails=all&rdprops=true` +
    `&ownonly=${args.ownOnly ? 'true' : 'false'}&allmsgs=true`;

  const { body } = await client.rawGet(path, { Accept: CTO_MEDIA_TYPE });

  // System changeability flags.
  const properties: Record<string, string> = {};
  const propRe = /<property\b([^>]*)\/>/g;
  let pm: RegExpExecArray | null;
  while ((pm = propRe.exec(body)) !== null) {
    const n = ctoAttr(pm[1], 'name');
    if (n) properties[n] = ctoAttr(pm[1], 'value');
  }

  // Requests, each with nested tasks and (optionally) objects.
  const requests: Array<Record<string, unknown>> = [];
  const reqRe = /<request\b([^>]*?)(?:\/>|>([\s\S]*?)<\/request>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = reqRe.exec(body)) !== null) {
    const reqAttrs = rm[1];
    const reqInner = rm[2] ?? '';
    const status = ctoAttr(reqAttrs, 'status');
    if (args.modifiableOnly && status !== 'D') continue;

    const tasks: Array<Record<string, unknown>> = [];
    const taskRe = /<task\b([^>]*?)(?:\/>|>([\s\S]*?)<\/task>)/g;
    let tm: RegExpExecArray | null;
    while ((tm = taskRe.exec(reqInner)) !== null) {
      const taskAttrs = tm[1];
      const taskInner = tm[2] ?? '';
      const task: Record<string, unknown> = {
        corrnum: ctoAttr(taskAttrs, 'corrnum'),
        owner: ctoAttr(taskAttrs, 'user'),
        function: ctoAttr(taskAttrs, 'function'),
        status: ctoAttr(taskAttrs, 'status'),
      };
      if (args.includeObjects) {
        const objects: Array<Record<string, unknown>> = [];
        const objRe = /<object\b([^>]*)\/>/g;
        let om: RegExpExecArray | null;
        while ((om = objRe.exec(taskInner)) !== null) {
          objects.push({
            pgmid: ctoAttr(om[1], 'pgmid'),
            type: ctoAttr(om[1], 'type'),
            name: ctoAttr(om[1], 'name'),
            locked: ctoAttr(om[1], 'locked') === 'true',
          });
        }
        task['objects'] = objects;
      }
      tasks.push(task);
    }

    requests.push({
      corrnum: ctoAttr(reqAttrs, 'corrnum'),
      text: ctoAttr(reqAttrs, 'txt'),
      owner: ctoAttr(reqAttrs, 'user'),
      function: ctoAttr(reqAttrs, 'function'),
      status,
      status_label: status === 'D' ? 'modifiable' : status === 'R' ? 'released' : status,
      target: ctoAttr(reqAttrs, 'target'),
      date: ctoAttr(reqAttrs, 'date'),
      time: ctoAttr(reqAttrs, 'time'),
      tasks,
    });
  }

  return JSON.stringify({
    transports_changeable: properties['transportsChangeable'] === 'true',
    bw_changeable: properties['bwChangeable'] === 'true',
    count: requests.length,
    requests,
  }, null, 2);
}
