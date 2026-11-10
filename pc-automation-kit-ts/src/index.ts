#!/usr/bin/env node
/**
 * PC Automation Kit — MCP server for SAP BW process chains.
 *
 * Same architecture as bw-modeling-mcp (src/index.ts), cut down to process chains:
 *   - TOOL_DEFINITIONS + handleToolCall + createServer + startStdio, as in the original.
 *   - Tool definitions and handler cases marked "from bw-modeling-mcp" are copied verbatim.
 *   - The block marked "NEW" adds run control (start / steps / status / restart / set status).
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { createClientFromEnv, type BwClient } from './bw-client.js';
import { currentClient } from './request-context.js';
import { filterToolsByScope, hasScope, requiredScope } from './scopes.js';
import { bwListChangeableTransports } from './tools/cto.js';
import { bwGetProcessChain } from './tools/processchain.js';
import { bwGetProcessVariant } from './tools/processvariant.js';
import { bwListRequests, bwGetRequest, bwActivateRequest } from './tools/request_monitor.js';
import { bwListProcessChainRuns, bwGetProcessChainRunDetail, bwListProcessChainLastStatus } from './tools/process_chain_monitor.js';
import { bwCreateProcessChain, bwUpdateProcessChain, bwActivateProcessChain, bwAddProcessChainErrorLinks, bwSwapProcessChainDtp, bwAppendProcessChainDtp, bwAddProcessChainProgram, bwCreateDecisionVariant, CreateProcessChainParams, UpdateProcessChainParams, EdgeDef, TriggerEventConfig } from './tools/processchain_write.js';
import { bwCreateTransportTask } from './tools/transport.js';
import {
  bwListProcessChainLog,
  bwGetProcessChainSteps,
  bwCheckRfcConnection,
  bwStartProcessChain,
  bwGetProcessChainStatus,
  bwRestartProcessChain,
  bwSetProcessStatus,
  bwInterruptProcessChain,
} from './tools/process_chain_control.js';

// Map the snake_case trigger_event tool argument to the TriggerEventConfig shape.
function mapTriggerEvent(raw: unknown): TriggerEventConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  if (e['event_id'] === undefined) return undefined;
  return {
    eventId: e['event_id'] as string,
    eventParameter: e['event_parameter'] as string | undefined,
    eventType: e['event_type'] as string | undefined,
    onlyOnce: e['only_once'] as boolean | undefined,
  };
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
    // ── from bw-modeling-mcp (verbatim) ────────────────────────────────────────
    {
      name: 'bw_get_process_chain',
      description:
        'Read a Process Chain (RSPC) definition — header metadata, scheduling and monitoring ' +
        'settings, all steps (nodes) with type, variant, and last execution status, ' +
        'step dependencies (edges) with branch conditions for DECISION nodes, ' +
        'and inline variant details. ' +
        'By default (include_variant_details=true), automatically fetches and embeds the full ' +
        'variant configuration for each step that has detail available. ' +
        'Steps without variant detail (DTP_LOAD, OR, AND, EXOR, CHAIN) are shown without extra detail — ' +
        'for DTP_LOAD use bw_get_dtp, for CHAIN use bw_get_process_chain recursively. ' +
        'Set include_variant_details=false for a faster structural overview without variant detail. ' +
        'Use bw_search with object_type=RSPC to find chain names first.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": full parsed JSON.',
          },
          include_variant_details: {
            type: 'boolean',
            description: 'If true (default), fetches variant configuration detail for each step automatically and includes it inline. Set to false to skip variant detail fetching for faster response on large chains.',
          },
        },
        required: ['chain_name'],
      },
    },
    {
      name: 'bw_get_process_variant',
      description:
        'Read the detail configuration of a single Process Variant from a Process Chain step. ' +
        'Covers all process types: ABAP (report name + selection variant), ADSOACT (aDSO activation), ' +
        'ADSOREM (request cleanup), PLSWITCHL/PLSWITCHP (planning mode switch), DTP_LOAD, ' +
        'DECISION, and any other type — oDetail is returned as indented JSON for unknown types. ' +
        'Get process_type and variant_name from bw_get_process_chain output (sProcessType and sProcessVariant fields). ' +
        'Use format="raw" to see the full unformatted JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          process_type: {
            type: 'string',
            description: 'Process type technical name from the chain step (e.g. "ABAP", "DTP_LOAD", "ADSOACT", "ADSOREM", "PLSWITCHL", "PLSWITCHP", "DECISION"). Case-insensitive.',
          },
          variant_name: {
            type: 'string',
            description: 'Process variant technical name from the chain step (e.g. "ILV_...", "DTP_...", "DEL_..."). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary with oDetail as indented JSON. "raw": full parsed JSON.',
          },
        },
        required: ['process_type', 'variant_name'],
      },
    },
    {
      name: 'bw_list_requests',
      description:
        'List the recent load requests of an InfoProvider from the runtime request monitor, ' +
        'with decoded request status, record counts and timestamps. ' +
        'Returns one entry per request including the internal request TSN, which is the ' +
        'input for bw_get_request. Read-only. ' +
        'Use bw_search to find the target technical name first. ' +
        'Performance: listing cost scales with the number of returned rows because each row ' +
        'is enriched on the backend (a per-row cross-reference read). top bounds the result set; ' +
        'created_from and status only help by returning fewer rows, not by making a row cheaper. ' +
        'For providers with long load histories, use a narrow created_from window or a small top.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target InfoProvider technical name (e.g. "OBJECT_NAME"). Case-insensitive.',
          },
          target_type: {
            type: 'string',
            description: 'Target object type (default "ADSO").',
          },
          storage: {
            type: 'string',
            description: 'Comma-separated storage area codes (default "AQ,AX,AT").',
          },
          status: {
            type: 'string',
            description: 'Comma-separated request status codes to include (default "N,GG,GR,YG,RR,YR,RG,U,Y,X").',
          },
          created_from: {
            type: 'string',
            description:
              'Optional server-side lower time bound, ISO 8601 with milliseconds and Z ' +
              '(24 chars, e.g. "YYYY-MM-DDTHH:MM:SS.000Z"). Returns only requests created at or ' +
              'after this time (open upper bound = now). Narrows the result set, which reduces ' +
              'per-row backend enrichment cost. Recommended for providers with long load histories.',
          },
          top: {
            type: 'number',
            description:
              'Upper cap on the number of requests to return (default 3). Each returned row triggers ' +
              'an expensive per-row backend read, so keep this small; raise it only when needed.',
          },
        },
        required: ['target'],
      },
    },
    {
      name: 'bw_get_request',
      description:
        'Full status analysis of one load request in a single call, bundling the request ' +
        'header, DTP information (including start, finish and duration), the process step ' +
        'chain and the message log. Read-only. ' +
        'The request TSN comes from bw_list_requests output.',
      inputSchema: {
        type: 'object',
        properties: {
          request_tsn: {
            type: 'string',
            description: 'Internal request TSN from bw_list_requests output.',
          },
          storage: {
            type: 'string',
            description:
              'Storage area code (default "AQ"). Take it from the "Storage" line of the ' +
              'bw_list_requests output — the code differs by target type (e.g. AQ inbound, ' +
              'AT/AX active data aDSO, ATTE active text table InfoObject). A wrong code 404s ' +
              'the header/DTP/process sections, but the message log is still returned.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary. "raw": full parsed JSON of all four payloads.',
          },
        },
        required: ['request_tsn'],
      },
    },
    {
      name: 'bw_activate_request',
      description:
        'Activate loaded data (DSO request activation): move a finished load from the Inbound ' +
        'Table into the active data table and change log. This is the runtime request activation, ' +
        'NOT the modeling-object activation done by bw_activate. ' +
        'Only applies to aDSOs that have an activation step (not inbound-only staging aDSOs). ' +
        'Activates all previous loads up to the given request. ' +
        'Asynchronous: a successful call starts activation; monitor completion via ' +
        'bw_list_requests / bw_get_request.',
      inputSchema: {
        type: 'object',
        properties: {
          request_tsn: {
            type: 'string',
            description: 'Load request TSN to activate (from bw_list_requests / bw_run_dtp output).',
          },
          storage: {
            type: 'string',
            description: 'Storage area code the request lives in (default "AQ").',
          },
        },
        required: ['request_tsn'],
      },
    },
    {
      name: 'bw_list_process_chain_runs',
      description:
        'List execution runs of one or all process chains from the process chain monitoring log. ' +
        'Each row represents one chain run with overall status, runtime deviation, start/end timestamps, and duration. ' +
        'Optionally filter by chain technical name, start date range, and status code. ' +
        'Returns the log_id of each run — pass chain_id + log_id into bw_get_process_chain_run_detail for step-level details. ' +
        'Ordered by start time descending. Default limit 20 runs.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_name: {
            type: 'string',
            description: 'Optional process chain technical name to restrict to runs of a single chain (e.g. "CHAIN_NAME"). Omit for system-wide results.',
          },
          date_from: {
            type: 'string',
            description: 'Optional lower bound for run start date (ISO format, e.g. "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"). Maps to startDate ge datetime filter.',
          },
          date_to: {
            type: 'string',
            description: 'Optional upper bound for run start date (ISO format). Maps to startDate le datetime filter.',
          },
          status: {
            type: 'string',
            description: 'Optional status code filter (e.g. as returned by the status field of previous runs). Resolves to eq filter on the status field.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of runs to return (default 20).',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_process_chain_run_detail',
      description:
        'Read the execution detail of one process chain run — all process steps with type, variant, status, ' +
        'timestamps, and parent/child relationships (predecessor graph edges), plus the full message log. ' +
        'chain_id and log_id come from bw_list_process_chain_runs or bw_list_process_chain_last_status output. ' +
        'Use this to diagnose a failed run: the message log contains the actual error messages.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME").',
          },
          log_id: {
            type: 'string',
            description: 'Run log ID from bw_list_process_chain_runs or bw_list_process_chain_last_status (logId field).',
          },
        },
        required: ['chain_id', 'log_id'],
      },
    },
    {
      name: 'bw_list_process_chain_last_status',
      description:
        'Read the latest execution status and scheduling state for every process chain in the system — ' +
        'one row per chain. Includes last run status, runtime deviation, scheduling status, next scheduled start, ' +
        'and the log_id of the most recent run (pass into bw_get_process_chain_run_detail to drill down). ' +
        'Chains that have never run appear here too. ' +
        'Optionally filter to chains whose last run has a specific status or whose last start date falls in a range.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Optional filter on last run status code. Returns only chains whose most recent run matches this status.',
          },
          last_start_from: {
            type: 'string',
            description: 'Optional lower bound for last run start date (ISO format, e.g. "YYYY-MM-DD"). Maps to lastStartDate ge datetime filter.',
          },
          last_start_to: {
            type: 'string',
            description: 'Optional upper bound for last run start date (ISO format). Maps to lastStartDate le datetime filter.',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of chains to return. Omit to return all.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_create_process_chain',
      description:
        'Create a Process Chain (RSPC) via the BW/4HANA Cockpit REST API. ' +
        'Builds the chain model from a list of steps and edges, creates it with a trigger-only skeleton, ' +
        'then updates it with the full model in a single operation. Optionally activates after creation. ' +
        'The TRIGGER (Start) node is implicit (node index 0) and must not be listed in steps. ' +
        'DTP_LOAD and generic referenced steps use bIsReference=true; ADSOACT and ADSOREM use inline variants. ' +
        'Collectors (AND, OR, XOR) require no extra fields beyond their type. ' +
        'Edge status defaults: neutral for edges whose source is TRIGGER or a collector; positive for all others. ' +
        'For two-step DTP loading always use bw_create_dtp first; this tool builds the process chain around existing DTPs. ' +
        'Supported step types: DTP_LOAD (DTP load), ADSOACT (DSO data activation), ADSOREM (DSO request cleanup), CHAIN (start a local sub-chain, verified), DECISION (branch on a decision variant, requires the variant field), and collectors AND / OR / XOR; the start trigger is implicit. ' +
        'A generic referenced-step path (any process type string plus an object name, bIsReference=true) is available and verified for DTP_LOAD and CHAIN; for other types it may work but is untested. ' +
        'Other inline-configuration process types (for example program execution, OS command, attribute change run) are not supported in this version. ' +
        'Edges support on-success (positive) and unconditional (neutral) links; on-error (negative) links are accepted in the schema but not emitted by default. ' +
        'DECISION branch edges: set sub_status to the branch EVENTNO ("01"=THEN/JA, "02"=ELSE/NEIN) — such edges are always positive. Create the referenced decision variant first with bw_create_decision_variant. ' +
        'To start the chain on an event instead of immediately, pass trigger_event (start type "E").',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name, uppercase, max 30 characters (e.g. "CHAIN_NAME").',
          },
          infoarea: {
            type: 'string',
            description: 'InfoArea to file the chain under (e.g. "AREA_NAME").',
          },
          description: {
            type: 'string',
            description: 'Short description / label for the process chain.',
          },
          steps: {
            type: 'array',
            description:
              'Ordered list of steps. The TRIGGER (Start) node is implicit at index 0 — do not include it here. ' +
              'Each step has a caller-chosen id used for edge wiring. ' +
              'Step types: DTP_LOAD (requires dtp field), ADSOACT (requires datastores array), ADSOREM (requires remDatastores array), ' +
              'CHAIN (requires object = sub-chain name), DECISION (requires variant = decision variant name), AND / OR / XOR (collector, no extra fields), or any other BW process type (requires object field).',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Caller-chosen identifier used to reference this step in edges (e.g. "step1").' },
                type: {
                  type: 'string',
                  description: 'Process type: "DTP_LOAD", "ADSOACT", "ADSOREM", "CHAIN", "DECISION", "AND", "OR", "XOR", or any BW process type string.',
                },
                dtp: { type: 'string', description: 'DTP technical name. Required when type is "DTP_LOAD" (e.g. "DTP_...").' },
                variant: { type: 'string', description: 'Decision variant technical name to reference. Required when type is "DECISION". Create it first with bw_create_decision_variant.' },
                description: { type: 'string', description: 'Step display description (used for DTP_LOAD, CHAIN, DECISION, and generic referenced steps).' },
                datastores: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of aDSO technical names to activate. Required when type is "ADSOACT".',
                },
                requestsSequential: {
                  type: 'boolean',
                  description: 'ADSOACT only. Activate requests sequentially (NOCONDENSE). Default false.',
                },
                errorOnNonActivation: {
                  type: 'boolean',
                  description: 'ADSOACT only. Error on non-activation of loaded requests (NOREQACTWARN). Default false.',
                },
                remDatastores: {
                  type: 'array',
                  description: 'Required when type is "ADSOREM" (DSO request cleanup). One entry per aDSO whose requests to clean up, each with its own cleanup action and request selection.',
                  items: {
                    type: 'object',
                    properties: {
                      datastore: { type: 'string', description: 'aDSO technical name (e.g. "ADSO_NAME").' },
                      action: { type: 'string', description: 'Cleanup action code from the cockpit "Bereinigungsaktion" dropdown (single character). Observed: "A" = activate requests, "C" = remove old requests from the change log. The valid action depends on the aDSO type; an unsuitable action is rejected at activation.' },
                      allRequests: { type: 'boolean', description: 'Clean up all requests (ALL_REQUESTS). When true, the count/age selectors are ignored. Default false.' },
                      numberRequests: { type: 'number', description: 'Keep the last N requests (NUMBER_REQUESTS); older ones are removed. Default 0.' },
                      numberDays: { type: 'number', description: 'Remove requests older than N days (NUMBER_DAYS). Default 0.' },
                      packageSize: { type: 'number', description: 'Processing package size (PACKAGE_SIZE); 0 = server default.' },
                    },
                  },
                },
                object: {
                  type: 'string',
                  description: 'Technical name of the referenced BW object. Required for CHAIN (sub-chain name) and other generic referenced step types (any type other than DTP_LOAD, ADSOACT, ADSOREM, AND, OR, XOR).',
                },
              },
              required: ['id', 'type'],
            },
          },
          edges: {
            type: 'array',
            description:
              'Directed edges connecting steps. Use the step id or the literal "TRIGGER" for the start node. ' +
              'Status defaults: "neutral" when the source is "TRIGGER" or a collector (AND/OR/XOR); "positive" otherwise. ' +
              'For a branch edge out of a DECISION node, set sub_status to the branch EVENTNO ("01"/"02"); such edges are forced to "positive".',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Source step id or "TRIGGER".' },
                to: { type: 'string', description: 'Target step id or "TRIGGER".' },
                status: {
                  type: 'string',
                  enum: ['neutral', 'positive', 'negative'],
                  description: 'Edge condition. Omit to use the default (see above).',
                },
                sub_status: {
                  type: 'string',
                  description: 'Branch condition (DECISION out-edges only): the branch EVENTNO, e.g. "01" (THEN/JA) or "02" (ELSE/NEIN). Defaults to "00" (normal edge).',
                },
              },
              required: ['from', 'to'],
            },
          },
          trigger_event: {
            type: 'object',
            description:
              'Optional event start-condition for the trigger (start type "E"). Omit for the default immediate start (start type "I").',
            properties: {
              event_id: { type: 'string', description: 'Event id, e.g. "SAP_TEST".' },
              event_parameter: { type: 'string', description: 'Event parameter. Defaults to the chain name when omitted.' },
              event_type: { type: 'string', description: 'Event type. Defaults to "OtherEvent".' },
              only_once: { type: 'boolean', description: 'Start only once. Default false.' },
            },
            required: ['event_id'],
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after creation. Default false.',
          },
        },
        required: ['name', 'infoarea', 'description', 'steps', 'edges'],
      },
    },
    {
      name: 'bw_update_process_chain',
      description:
        'Replace the step model (nodes and edges) of an existing Process Chain (RSPC) via the BW/4HANA Cockpit REST API. ' +
        'Reads the current chain to obtain the ETag and preserve the existing trigger node (with its scheduling configuration) ' +
        'and the current header. Replaces only the steps and edges; the trigger is always preserved as-is. ' +
        'Optionally overrides description and infoarea in the header. ' +
        'Optionally activates after the update. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly. ' +
        'Use bw_create_process_chain to create a new chain; use this tool to update an existing one. ' +
        'Supported step types: DTP_LOAD (DTP load), ADSOACT (DSO data activation), ADSOREM (DSO request cleanup), CHAIN (start a local sub-chain, verified), DECISION (branch on a decision variant, requires the variant field), and collectors AND / OR / XOR; the start trigger is implicit. ' +
        'A generic referenced-step path (any process type string plus an object name, bIsReference=true) is available and verified for DTP_LOAD and CHAIN; for other types it may work but is untested. ' +
        'Other inline-configuration process types (for example program execution, OS command, attribute change run) are not supported in this version. ' +
        'Edges support on-success (positive) and unconditional (neutral) links; on-error (negative) links are accepted in the schema but not emitted by default. ' +
        'DECISION branch edges: set sub_status to the branch EVENTNO ("01"/"02"); such edges are always positive. ' +
        'The trigger is preserved as-is unless trigger_event is passed (which sets an event start-condition); an existing event start-condition is preserved across updates.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          description: {
            type: 'string',
            description: 'Optional new description. If omitted, the existing chain description is kept.',
          },
          infoarea: {
            type: 'string',
            description: 'Optional new InfoArea. If omitted, the existing InfoArea is kept.',
          },
          steps: {
            type: 'array',
            description:
              'Complete replacement step list. The TRIGGER (Start) node is implicit at index 0 — do not include it here. ' +
              'Same shape as in bw_create_process_chain.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Caller-chosen identifier used to reference this step in edges.' },
                type: {
                  type: 'string',
                  description: 'Process type: "DTP_LOAD", "ADSOACT", "ADSOREM", "CHAIN", "DECISION", "AND", "OR", "XOR", or any BW process type string.',
                },
                dtp: { type: 'string', description: 'DTP technical name. Required when type is "DTP_LOAD".' },
                variant: { type: 'string', description: 'Decision variant technical name to reference. Required when type is "DECISION".' },
                description: { type: 'string', description: 'Step display description (DTP_LOAD, CHAIN, DECISION, and generic referenced steps).' },
                datastores: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'aDSO technical names to activate. Required when type is "ADSOACT".',
                },
                requestsSequential: {
                  type: 'boolean',
                  description: 'ADSOACT only. Activate requests sequentially (NOCONDENSE). Default false.',
                },
                errorOnNonActivation: {
                  type: 'boolean',
                  description: 'ADSOACT only. Error on non-activation of loaded requests (NOREQACTWARN). Default false.',
                },
                remDatastores: {
                  type: 'array',
                  description: 'Required when type is "ADSOREM" (DSO request cleanup). One entry per aDSO whose requests to clean up, each with its own cleanup action and request selection.',
                  items: {
                    type: 'object',
                    properties: {
                      datastore: { type: 'string', description: 'aDSO technical name (e.g. "ADSO_NAME").' },
                      action: { type: 'string', description: 'Cleanup action code from the cockpit "Bereinigungsaktion" dropdown (single character). Observed: "A" = activate requests, "C" = remove old requests from the change log. The valid action depends on the aDSO type; an unsuitable action is rejected at activation.' },
                      allRequests: { type: 'boolean', description: 'Clean up all requests (ALL_REQUESTS). When true, the count/age selectors are ignored. Default false.' },
                      numberRequests: { type: 'number', description: 'Keep the last N requests (NUMBER_REQUESTS); older ones are removed. Default 0.' },
                      numberDays: { type: 'number', description: 'Remove requests older than N days (NUMBER_DAYS). Default 0.' },
                      packageSize: { type: 'number', description: 'Processing package size (PACKAGE_SIZE); 0 = server default.' },
                    },
                  },
                },
                object: {
                  type: 'string',
                  description: 'Technical name of the referenced BW object. Required for generic referenced step types.',
                },
              },
              required: ['id', 'type'],
            },
          },
          edges: {
            type: 'array',
            description:
              'Complete replacement edge list. Use the step id or the literal "TRIGGER" for the start node. ' +
              'Status defaults: "neutral" when the source is "TRIGGER" or a collector (AND/OR/XOR); "positive" otherwise. ' +
              'For a branch edge out of a DECISION node, set sub_status to the branch EVENTNO ("01"/"02"); such edges are forced to "positive".',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string', description: 'Source step id or "TRIGGER".' },
                to: { type: 'string', description: 'Target step id or "TRIGGER".' },
                status: {
                  type: 'string',
                  enum: ['neutral', 'positive', 'negative'],
                  description: 'Edge condition. Omit to use the default.',
                },
                sub_status: {
                  type: 'string',
                  description: 'Branch condition (DECISION out-edges only): the branch EVENTNO, e.g. "01" (THEN/JA) or "02" (ELSE/NEIN). Defaults to "00" (normal edge).',
                },
              },
              required: ['from', 'to'],
            },
          },
          trigger_event: {
            type: 'object',
            description:
              'Optional event start-condition for the trigger (start type "E"). When omitted, an existing event start-condition is preserved and a non-event trigger stays immediate.',
            properties: {
              event_id: { type: 'string', description: 'Event id, e.g. "SAP_TEST".' },
              event_parameter: { type: 'string', description: 'Event parameter. Defaults to the chain name when omitted.' },
              event_type: { type: 'string', description: 'Event type. Defaults to "OtherEvent".' },
              only_once: { type: 'boolean', description: 'Start only once. Default false.' },
            },
            required: ['event_id'],
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the update. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'steps', 'edges'],
      },
    },
    {
      name: 'bw_activate_process_chain',
      description:
        'Activate an existing Process Chain (RSPC) via the BW/4HANA Cockpit REST API. ' +
        'Use this after bw_create_process_chain (with activate=false) or to re-activate a modified chain. ' +
        'Returns the top-level activation message, severity, and full log entries. ' +
        'Surfaces any log entries with severity "error" in a dedicated errors field.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_create_decision_variant',
      description:
        'Create a DECISION process variant (a standalone TLOGO object) for use as a branch/decision step in a Process Chain, via the BW/4HANA Cockpit REST API. ' +
        'The variant holds two branches indexed by position: THEN/first (EVENTNO "01" by default, label "JA") and ELSE/second (EVENTNO "02", label "NEIN"). ' +
        'The formula is the branch condition (e.g. "GET_SEGMENT( ) = \' 3\'"); it is evaluated for the THEN branch, the ELSE branch is its complement. ' +
        'The variant is created AND activated (activation is mandatory — an inactive variant is not selectable in the chain variant picker). ' +
        'After creation, reference the variant from a DECISION step in bw_create_process_chain / bw_update_process_chain (variant=<this name>), and branch its out-edges with sub_status "01"/"02". ' +
        'Package/transport: $TMP is fine for visibility and picker selection; pass a transportable package (NOT $TMP) only if you need to transport the variant. ' +
        'For a transportable package a transport_request is used (auto-selected when exactly one changeable request is available; pass it to disambiguate).',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Decision variant technical name, uppercase (e.g. "VARIANT_NAME"). This is the name a chain DECISION step references.',
          },
          description: {
            type: 'string',
            description: 'Variant description / label.',
          },
          formula: {
            type: 'string',
            description: 'Branch condition formula (BW decision formula syntax), e.g. "GET_SEGMENT( ) = \' 3\'".',
          },
          package: {
            type: 'string',
            description: 'Target package. Defaults to $TMP, which is fine for visibility/picker selection. Pass a transportable package only if the variant must be transportable.',
          },
          transport_request: {
            type: 'string',
            description: 'Transport request to record the new variant into. Used only for a transportable package (auto-selected when exactly one changeable request is available; pass to disambiguate).',
          },
          then_label: {
            type: 'string',
            description: 'Label of the THEN/first branch. Default "JA".',
          },
          else_label: {
            type: 'string',
            description: 'Label of the ELSE/second branch. Default "NEIN".',
          },
          then_event_no: {
            type: 'string',
            description: 'EVENTNO of the THEN branch (referenced by chain branch edges via sub_status). Default "01".',
          },
          else_event_no: {
            type: 'string',
            description: 'EVENTNO of the ELSE branch. Default "02".',
          },
        },
        required: ['name', 'description', 'formula'],
      },
    },
    {
      name: 'bw_add_process_chain_error_links',
      description:
        'Add on-error (negative) links to an existing Process Chain (RSPC) by mirroring the existing ' +
        'on-success (positive) out-edges of its DTP load steps, via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, appends the negative edges (skipping any that already exist), and PUTs it back. ' +
        'Optionally activates afterwards. ' +
        'Use dtps to restrict to specific steps; omit it to apply to every DTP load step. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          dtps: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional. Restrict to these steps. Each entry is matched against a step\'s DTP name (exact) ' +
              'or as a substring of its step description (which contains the target object name). ' +
              'Omit to apply to all DTP load steps.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_swap_process_chain_dtp',
      description:
        'Swap one DTP load variant for another in an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'In-place edit: reads the current model, replaces the matching DTP_LOAD node\'s variant, and PUTs it back — ' +
        'edges and all other nodes are preserved unchanged. Prefer this over bw_update_process_chain for a single-variant swap, ' +
        'since it does not require re-specifying the whole chain. ' +
        'Optionally activates afterwards. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          old_dtp: {
            type: 'string',
            description: 'DTP variant name currently in the chain (e.g. "DTP_NAME_OLD").',
          },
          new_dtp: {
            type: 'string',
            description: 'DTP variant name to set instead (e.g. "DTP_NAME_NEW").',
          },
          refresh_description: {
            type: 'boolean',
            description: 'If true (default), pull the new variant\'s step description from its metadata. Cosmetic; the existing description is kept if metadata is unavailable.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'old_dtp', 'new_dtp'],
      },
    },
    {
      name: 'bw_append_process_chain_dtp',
      description:
        'Append one DTP load step (optionally followed by its own DSO activation step) to an existing Process Chain (RSPC), ' +
        'via the BW/4HANA Cockpit REST API. In-place edit: reads the current model, appends the node(s)/edge(s)/inline variant, ' +
        'and PUTs it back — the caller does not supply the full model. ' +
        'By default it appends behind the strand end closest to the trigger (to keep strands balanced); pass predecessor to choose a node. ' +
        'edge_mode "both" (default) adds an on-success and an on-error edge per link ("always continue"); "success_only" adds only the on-success edge. ' +
        'Idempotent: if the DTP is already a node in the chain, it is skipped without writing. ' +
        'Optionally activates afterwards and then verifies that no collector was inserted and no extra strand appeared. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          dtp: {
            type: 'string',
            description: 'DTP variant name to append (e.g. "DTP_NAME").',
          },
          adsoact: {
            type: 'string',
            description: 'Optional aDSO name (e.g. "ADSO_NAME"). When given, an ADSOACT step activating this aDSO is added right after the DTP (per-DTP activation).',
          },
          predecessor: {
            type: 'string',
            description:
              'Node to append behind: a DTP variant name, an aDSO whose ADSOACT node holds it, or the literal "strand_end_auto" (default). ' +
              'For "strand_end_auto" the terminal node closest to the trigger is chosen (ties → first).',
          },
          edge_mode: {
            type: 'string',
            enum: ['both', 'success_only'],
            description: '"both" (default): add an on-success and an on-error edge per link. "success_only": add only the on-success edge.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'dtp'],
      },
    },
    {
      name: 'bw_add_process_chain_program',
      description:
        'Add an "Execute ABAP Program" step (RSPC process type ABAP, "Programm ausführen") to an existing Process Chain (RSPC), via the BW/4HANA Cockpit REST API. ' +
        'Runs an ABAP report, optionally with a named SE38 selection variant. ' +
        'In-place edit: reads the current model, inserts the node + its INLINE process variant (the program call is stored inline in the chain — there is no separate variant object), and PUTs it back. ' +
        'Positioning: pass "before" to run the program ahead of an existing step (the target\'s incoming edges are rerouted through the new step, e.g. Start → PROGRAM → DTP); pass "after" to run it between a step and its successors; pass neither (optionally with predecessor) to append behind the strand end closest to the trigger. ' +
        'edge_mode "both" (default) adds an on-success and an on-error edge per new link; "success_only" adds only the on-success edge. ' +
        'Idempotent: if an ABAP step already calls the same program (and variant), it is skipped without writing. ' +
        'Only the synchronous/local/program call configuration is verified; keep the defaults. ' +
        'A 412 on the PUT means the ETag was stale (chain modified between read and write); the error reports this explicitly.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          program: {
            type: 'string',
            description: 'ABAP program / report to execute (e.g. "REPORT_NAME").',
          },
          variant: {
            type: 'string',
            description: 'Optional ABAP report (SE38) selection variant name (e.g. "VARIANT_NAME"). Omit to run the report without a variant.',
          },
          description: {
            type: 'string',
            description: 'Optional step description (cosmetic).',
          },
          before: {
            type: 'string',
            description:
              'Insert the program step BEFORE this node (its DTP/variant name, or an aDSO held by an ADSOACT node). ' +
              'The target\'s incoming edges are rerouted through the new step. Mutually exclusive with "after".',
          },
          after: {
            type: 'string',
            description:
              'Insert the program step AFTER this node — it runs between the target and its former successors. Mutually exclusive with "before".',
          },
          predecessor: {
            type: 'string',
            description:
              'Used only when neither before nor after is given. Node to append behind (a DTP/variant name, an aDSO held by an ADSOACT node) or the literal "strand_end_auto" (default = terminal node closest to the trigger).',
          },
          edge_mode: {
            type: 'string',
            enum: ['both', 'success_only'],
            description: '"both" (default): add an on-success and an on-error edge per new link. "success_only": add only the on-success edge.',
          },
          program_package: {
            type: 'string',
            description: 'Optional package of the report (cosmetic value-help enrichment; the server re-derives it when omitted).',
          },
          program_description: {
            type: 'string',
            description: 'Optional report description (cosmetic).',
          },
          variant_description: {
            type: 'string',
            description: 'Optional variant description (cosmetic).',
          },
          synchronous: {
            type: 'boolean',
            description: 'Call mode. true (default) runs the program synchronously (X_SYNCHRON). Only the default is verified.',
          },
          local: {
            type: 'boolean',
            description: 'Call location. true (default) runs the program on this system (X_LOCAL). Only the default is verified.',
          },
          activate: {
            type: 'boolean',
            description: 'If true, activate the chain immediately after the edit. Default false.',
          },
          transport_request: {
            type: 'string',
            description:
              'Optional transport request to record the change into. Only relevant when the chain is in a transportable package (not $TMP). ' +
              'If the chain is transportable and exactly one request is available, it is chosen automatically; pass this to disambiguate when several are available. ' +
              'Ignored for $TMP (local) chains.',
          },
        },
        required: ['name', 'program'],
      },
    },
    {
      name: 'bw_create_transport_task',
      description:
        'Add a task (sub-request) for a user to an existing workbench transport request. ' +
        'Single ADT call, no lock or activation. The parent request must be modifiable. ' +
        'Returns the created task number.',
      inputSchema: {
        type: 'object',
        properties: {
          transport_request: {
            type: 'string',
            description: 'Parent workbench transport request number (e.g. DEVK900123).',
          },
          user: {
            type: 'string',
            description: 'Target user the task is created for (task owner), e.g. "USERNAME".',
          },
        },
        required: ['transport_request', 'user'],
      },
    },
    {
      name: 'bw_list_changeable_transports',
      description:
        'List transport requests and their tasks via the BW transport state (cto/check). ' +
        'Defaults to the caller\'s modifiable requests. Use this to find an open request to assign an object to.',
      inputSchema: {
        type: 'object',
        properties: {
          own_only: {
            type: 'boolean',
            description: 'Only the caller\'s own requests (default true). false widens to all users.',
          },
          modifiable_only: {
            type: 'boolean',
            description: 'Only modifiable requests, i.e. status "D" (default true). false also returns released requests.',
          },
          include_objects: {
            type: 'boolean',
            description: 'Include the objects contained in each task (default false).',
          },
        },
      },
    },
    // ── NEW: process chain run control (PC automation kit) ───────────────────
    {
      name: 'bw_list_process_chain_log',
      description:
        'List process chain runs from the run log table RSPCLOGCHAIN (works on BW/4HANA and BW 7.5). ' +
        'Newest first. Each run shows its log ID, start time, status (G/F green, R/X/J red, A yellow) ' +
        'and, for sub-chain runs, the parent run that called it. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Technical process chain name, e.g. "ZPC_TPM_BPO". Omit for all chains.' },
          status: { type: 'string', description: 'Filter by run status code, e.g. "R" for failed runs, "A" for active.' },
          date_from: { type: 'string', description: 'Only runs started on or after this date (YYYY-MM-DD, system date).' },
          limit: { type: 'number', description: 'Maximum runs to return (default 20, max 500).' },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_process_chain_steps',
      description:
        'Show every step (process) of one process chain run with status, colour, start/end, runtime, ' +
        'instance and background job, read from RSPCPROCESSLOG (works on BW/4HANA and BW 7.5). ' +
        'Descends into sub-chains (TYPE=CHAIN) and lists the failed leaf steps with the chain_id/log_id ' +
        'to pass to bw_restart_process_chain. For active steps the background job status (TBTCO) is shown, ' +
        'which tells a running step from a stuck one. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Technical process chain name.' },
          log_id: { type: 'string', description: 'Run log ID. Omit for the latest run of the chain.' },
          recursive: { type: 'boolean', description: 'Descend into sub-chains (default true).' },
          include_job_status: { type: 'boolean', description: 'Look up the background job of active steps (default true).' },
        },
        required: ['chain_id'],
      },
    },
    {
      name: 'bw_check_rfc_connection',
      description:
        'Check that SAP function modules can be called over HTTPS via the SOAP-RFC service /sap/bc/soap/rfc ' +
        '(RFC_PING + RFC_SYSTEM_INFO). Required by bw_start_process_chain, bw_get_process_chain_status, ' +
        'bw_restart_process_chain, bw_set_process_status and bw_interrupt_process_chain. Read-only.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'bw_get_process_chain_status',
      description:
        'Overall status of one run via the SAP API RSPC_API_CHAIN_GET_STATUS (SOAP-RFC). ' +
        'By default the log is not updated (I_DONT_UPDATE=X). Read-only unless refresh=true.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Technical process chain name.' },
          log_id: { type: 'string', description: 'Run log ID.' },
          refresh: { type: 'boolean', description: 'Let SAP re-evaluate the run and update its log status (default false).' },
        },
        required: ['chain_id', 'log_id'],
      },
    },
    {
      name: 'bw_start_process_chain',
      description:
        'Start a process chain now via the SAP API RSPC_API_CHAIN_START (SOAP-RFC). Returns the new run log ID. ' +
        'The chain must be active. CHANGES SYSTEM STATE — loads data.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Technical process chain name.' },
          synchronous: { type: 'boolean', description: 'Run synchronously in this call (default false). Only for short test chains.' },
        },
        required: ['chain_id'],
      },
    },
    {
      name: 'bw_restart_process_chain',
      description:
        'Rerun ONLY the failed steps of one run via the SAP API RSPC_API_CHAIN_RESTART with I_ONLY_RED=X — ' +
        'the same logic as the Repeat button in RSPC. SAP decides per step whether to repair (same instance/request) ' +
        'or repeat (new instance). The rest of the chain continues from there. For a failure inside a sub-chain, pass ' +
        'the sub-chain chain_id and its own log_id (shown by bw_get_process_chain_steps). Refuses while a step of the ' +
        'run is still active unless force=true. CHANGES SYSTEM STATE.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Chain that owns the failed step (the sub-chain, for nested failures).' },
          log_id: { type: 'string', description: 'Run log ID of that chain.' },
          only_red: { type: 'boolean', description: 'Restart only failed (red) steps (default true).' },
          force: { type: 'boolean', description: 'Restart even if a step still shows active (default false).' },
        },
        required: ['chain_id', 'log_id'],
      },
    },
    {
      name: 'bw_set_process_status',
      description:
        'Manually set the status of one step via RSPC_PROCESS_FINISH (SOAP-RFC), e.g. mark a stuck step red (R) so it ' +
        'can be restarted, or green (G) to let a held chain continue. Does NOT execute the step. Take type, variant and ' +
        'instance from bw_get_process_chain_steps. CHANGES SYSTEM STATE.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Chain that owns the step.' },
          log_id: { type: 'string', description: 'Run log ID of that chain.' },
          process_type: { type: 'string', description: 'Process type, e.g. DTP_LOAD, ADSOACT, ABAP.' },
          variant: { type: 'string', description: 'Process variant name.' },
          instance: { type: 'string', description: 'Process instance.' },
          state: { type: 'string', enum: ['R', 'G', 'F', 'X'], description: 'New state: R=error, G=success, F=completed, X=cancelled.' },
        },
        required: ['chain_id', 'log_id', 'process_type', 'variant', 'instance', 'state'],
      },
    },
    {
      name: 'bw_interrupt_process_chain',
      description:
        'Stop a process chain via RSPC_API_CHAIN_INTERRUPT (SOAP-RFC): removes its scheduled start; with kill=true ' +
        'running jobs are cancelled. The chain must be scheduled again afterwards. CHANGES SYSTEM STATE.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: { type: 'string', description: 'Technical process chain name.' },
          kill: { type: 'boolean', description: 'Also cancel running jobs (default false).' },
        },
        required: ['chain_id'],
      },
    },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

async function handleToolCall(
  request: { params: { name: string; arguments?: Record<string, unknown> } },
  extra: { authInfo?: AuthInfo },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const { name, arguments: args } = request.params;

  // Deny before doing any work. stdio has no authInfo and nothing to check.
  if (!hasScope(extra.authInfo, requiredScope(name))) {
    throw new McpError(ErrorCode.InvalidRequest, `Tool '${name}' requires the '${requiredScope(name)}' scope.`);
  }

  // HTTP: the per-request client, whose identity came from XSUAA and the destination.
  // stdio: no request context, so read the environment exactly as before.
  const client = currentClient() ?? createClientFromEnv();

  try {
    await ensureMediaTypes(client);
    let text: string;

    switch (name) {
      // ── from bw-modeling-mcp (verbatim) ──────────────────────────────────────
      case 'bw_get_process_chain':
        text = await bwGetProcessChain(
          client,
          args?.chain_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
          args?.include_variant_details !== false,
        );
        break;

      case 'bw_get_process_variant':
        text = await bwGetProcessVariant(
          client,
          args?.process_type as string,
          args?.variant_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_list_requests':
        text = await bwListRequests(
          client,
          args?.target as string,
          args?.target_type as string | undefined ?? 'ADSO',
          args?.storage as string | undefined ?? 'AQ,AX,AT',
          args?.status as string | undefined ?? 'N,GG,GR,YG,RR,YR,RG,U,Y,X',
          args?.top as number | undefined ?? 3,
          args?.created_from as string | undefined,
        );
        break;

      case 'bw_get_request':
        text = await bwGetRequest(
          client,
          args?.request_tsn as string,
          args?.storage as string | undefined ?? 'AQ',
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_activate_request':
        text = await bwActivateRequest(
          args?.request_tsn as string,
          args?.storage as string | undefined ?? 'AQ',
        );
        break;

      case 'bw_list_process_chain_runs':
        text = await bwListProcessChainRuns(
          client,
          args?.chain_name as string | undefined,
          args?.date_from as string | undefined,
          args?.date_to as string | undefined,
          args?.status as string | undefined,
          (args?.limit as number | undefined) ?? 20,
        );
        break;

      case 'bw_get_process_chain_run_detail':
        text = await bwGetProcessChainRunDetail(
          client,
          args?.chain_id as string,
          args?.log_id as string,
        );
        break;

      case 'bw_list_process_chain_last_status':
        text = await bwListProcessChainLastStatus(
          client,
          args?.status as string | undefined,
          args?.last_start_from as string | undefined,
          args?.last_start_to as string | undefined,
          args?.limit as number | undefined,
        );
        break;

      case 'bw_create_process_chain': {
        const rawSteps = (args?.steps as Array<Record<string, unknown>>) ?? [];
        const steps = rawSteps.map((s) => {
          const base: Record<string, unknown> = { id: s['id'], type: s['type'] };
          if (s['dtp'] !== undefined) base['dtp'] = s['dtp'];
          if (s['variant'] !== undefined) base['variant'] = s['variant'];
          if (s['description'] !== undefined) base['description'] = s['description'];
          if (s['datastores'] !== undefined) base['datastores'] = s['datastores'];
          if (s['requestsSequential'] !== undefined) base['requestsSequential'] = s['requestsSequential'];
          if (s['errorOnNonActivation'] !== undefined) base['errorOnNonActivation'] = s['errorOnNonActivation'];
          if (s['remDatastores'] !== undefined) base['remDatastores'] = s['remDatastores'];
          if (s['object'] !== undefined) base['object'] = s['object'];
          return base;
        });
        const rawEdges = (args?.edges as Array<Record<string, unknown>>) ?? [];
        const edges: EdgeDef[] = rawEdges.map((e) => ({
          from: e['from'] as string,
          to: e['to'] as string,
          status: e['status'] as 'neutral' | 'positive' | 'negative' | undefined,
          subStatus: e['sub_status'] as string | undefined,
        }));
        text = await bwCreateProcessChain(client, {
          name: args?.name as string,
          infoarea: args?.infoarea as string,
          description: args?.description as string,
          steps: steps as unknown as CreateProcessChainParams['steps'],
          edges,
          activate: (args?.activate as boolean) ?? false,
          triggerEvent: mapTriggerEvent(args?.trigger_event),
        });
        break;
      }

      case 'bw_update_process_chain': {
        const rawSteps2 = (args?.steps as Array<Record<string, unknown>>) ?? [];
        const steps2 = rawSteps2.map((s) => {
          const base: Record<string, unknown> = { id: s['id'], type: s['type'] };
          if (s['dtp'] !== undefined) base['dtp'] = s['dtp'];
          if (s['variant'] !== undefined) base['variant'] = s['variant'];
          if (s['description'] !== undefined) base['description'] = s['description'];
          if (s['datastores'] !== undefined) base['datastores'] = s['datastores'];
          if (s['requestsSequential'] !== undefined) base['requestsSequential'] = s['requestsSequential'];
          if (s['errorOnNonActivation'] !== undefined) base['errorOnNonActivation'] = s['errorOnNonActivation'];
          if (s['remDatastores'] !== undefined) base['remDatastores'] = s['remDatastores'];
          if (s['object'] !== undefined) base['object'] = s['object'];
          return base;
        });
        const rawEdges2 = (args?.edges as Array<Record<string, unknown>>) ?? [];
        const edges2: EdgeDef[] = rawEdges2.map((e) => ({
          from: e['from'] as string,
          to: e['to'] as string,
          status: e['status'] as 'neutral' | 'positive' | 'negative' | undefined,
          subStatus: e['sub_status'] as string | undefined,
        }));
        text = await bwUpdateProcessChain(client, {
          name: args?.name as string,
          description: args?.description as string | undefined,
          infoarea: args?.infoarea as string | undefined,
          steps: steps2 as unknown as UpdateProcessChainParams['steps'],
          edges: edges2,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
          triggerEvent: mapTriggerEvent(args?.trigger_event),
        });
        break;
      }

      case 'bw_create_decision_variant':
        text = await bwCreateDecisionVariant(client, {
          name: args?.name as string,
          description: args?.description as string,
          formula: args?.formula as string,
          package: args?.package as string | undefined,
          transportRequest: args?.transport_request as string | undefined,
          thenLabel: args?.then_label as string | undefined,
          elseLabel: args?.else_label as string | undefined,
          thenEventNo: args?.then_event_no as string | undefined,
          elseEventNo: args?.else_event_no as string | undefined,
        });
        break;

      case 'bw_activate_process_chain':
        text = await bwActivateProcessChain(client, args?.name as string);
        break;

      case 'bw_add_process_chain_error_links':
        text = await bwAddProcessChainErrorLinks(client, {
          name: args?.name as string,
          dtps: args?.dtps as string[] | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_swap_process_chain_dtp':
        text = await bwSwapProcessChainDtp(client, {
          name: args?.name as string,
          oldDtp: args?.old_dtp as string,
          newDtp: args?.new_dtp as string,
          refreshDescription: (args?.refresh_description as boolean | undefined) ?? true,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_append_process_chain_dtp':
        text = await bwAppendProcessChainDtp(client, {
          name: args?.name as string,
          dtp: args?.dtp as string,
          adsoact: args?.adsoact as string | undefined,
          predecessor: args?.predecessor as string | undefined,
          edgeMode: args?.edge_mode as 'both' | 'success_only' | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_add_process_chain_program':
        text = await bwAddProcessChainProgram(client, {
          name: args?.name as string,
          program: args?.program as string,
          variant: args?.variant as string | undefined,
          description: args?.description as string | undefined,
          before: args?.before as string | undefined,
          after: args?.after as string | undefined,
          predecessor: args?.predecessor as string | undefined,
          edgeMode: args?.edge_mode as 'both' | 'success_only' | undefined,
          programPackage: args?.program_package as string | undefined,
          programDescription: args?.program_description as string | undefined,
          variantDescription: args?.variant_description as string | undefined,
          synchronous: args?.synchronous as boolean | undefined,
          local: args?.local as boolean | undefined,
          activate: (args?.activate as boolean) ?? false,
          transportRequest: args?.transport_request as string | undefined,
        });
        break;

      case 'bw_create_transport_task':
        text = await bwCreateTransportTask(client, {
          transportRequest: args?.transport_request as string,
          user: args?.user as string,
        });
        break;

      case 'bw_list_changeable_transports':
        text = await bwListChangeableTransports(client, {
          ownOnly: args?.own_only as boolean ?? true,
          modifiableOnly: args?.modifiable_only as boolean ?? true,
          includeObjects: args?.include_objects as boolean ?? false,
        });
        break;

      // ── NEW: process chain run control ─────────────────────────────────────
      case 'bw_list_process_chain_log':
        text = await bwListProcessChainLog(
          client,
          args?.chain_id as string | undefined,
          args?.status as string | undefined,
          args?.date_from as string | undefined,
          (args?.limit as number | undefined) ?? 20,
        );
        break;

      case 'bw_get_process_chain_steps':
        text = await bwGetProcessChainSteps(
          client,
          args?.chain_id as string,
          args?.log_id as string | undefined,
          args?.recursive !== false,
          args?.include_job_status !== false,
        );
        break;

      case 'bw_check_rfc_connection':
        text = await bwCheckRfcConnection(client);
        break;

      case 'bw_get_process_chain_status':
        text = await bwGetProcessChainStatus(
          client,
          args?.chain_id as string,
          args?.log_id as string,
          args?.refresh === true,
        );
        break;

      case 'bw_start_process_chain':
        text = await bwStartProcessChain(client, args?.chain_id as string, args?.synchronous === true);
        break;

      case 'bw_restart_process_chain':
        text = await bwRestartProcessChain(
          client,
          args?.chain_id as string,
          args?.log_id as string,
          args?.only_red !== false,
          args?.force === true,
        );
        break;

      case 'bw_set_process_status':
        text = await bwSetProcessStatus(
          client,
          args?.chain_id as string,
          args?.log_id as string,
          args?.process_type as string,
          args?.variant as string,
          args?.instance as string,
          args?.state as string,
        );
        break;

      case 'bw_interrupt_process_chain':
        text = await bwInterruptProcessChain(client, args?.chain_id as string, args?.kill === true);
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Return as error content so Claude can see the details
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

/**
 * Build an MCP server with every tool registered.
 *
 * A factory rather than a module-level instance: the SDK binds a Server to exactly one
 * transport for its lifetime, so the stateless HTTP transport needs a fresh one per
 * request. stdio calls this once.
 */
export function createServer(): Server {
  const server = new Server(
    { name: 'bw-pc-automation-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => ({
    // Hide what the caller may not invoke, so a model never proposes a denied call.
    tools: filterToolsByScope(TOOL_DEFINITIONS, extra.authInfo),
  }));

  server.setRequestHandler(CallToolRequestSchema, handleToolCall);

  return server;
}

/**
 * Populate MEDIA_TYPES on first use rather than at startup.
 *
 * The HTTP transport has no credentials at boot — they arrive with the request — so
 * discovery cannot run there. The type->MIME map is system metadata, identical for every
 * caller, so one process-wide cache is correct.
 *
 * Cleared on failure: otherwise one transient error during the very first request would
 * leave the fallbacks in place for the life of the process, and later reads would fail
 * with a misleading "object type not supported on this system".
 */
let discovery: Promise<void> | null = null;
export function ensureMediaTypes(client: BwClient): Promise<void> {
  if (!discovery) {
    discovery = client.loadMediaTypes().catch((err) => {
      discovery = null;
      process.stderr.write(`[bw-modeling-mcp] Warning: discovery failed, using hardcoded media type fallbacks (${err})\n`);
    });
  }
  return discovery;
}

// ── Start (stdio) ─────────────────────────────────────────────────────────────

export async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
  // Log to stderr only (stdout is used for MCP protocol messages)
  process.stderr.write('bw-pc-automation-mcp server started\n');
}

// ── Backward-compatible entrypoint ──────────────────────────────────────────────
//
// Historically the stdio server was launched via `node dist/index.js`, and many local
// MCP client configs still point there. The BTP refactor turned this file into a shared
// module imported by stdio.ts and http.ts, so it no longer self-started. Restore the old
// behaviour: start the stdio server when this file is the process entry point. When it is
// imported (stdio.ts / http.ts), import.meta.url differs from argv[1], so this is a no-op
// and never double-starts.
function isRunAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isRunAsMain()) {
  startStdio().catch((err) => {
    process.stderr.write(`Fatal error: ${err}\n`);
    process.exit(1);
  });
}
