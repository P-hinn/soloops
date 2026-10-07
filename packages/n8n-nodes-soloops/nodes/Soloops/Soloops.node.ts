import type { INodeType, INodeTypeDescription } from 'n8n-workflow'
// The value lives under the plural name; `NodeConnectionType` is the type.
import { NodeConnectionTypes } from 'n8n-workflow'

import { leadFields, leadOperations } from './LeadDescription'
import { projectFields, projectOperations } from './ProjectDescription'
import { taskFields, taskOperations } from './TaskDescription'
import { timeFields, timeOperations } from './TimeDescription'
import { noteFields, noteOperations } from './NoteDescription'

/**
 * The soloops action node.
 *
 * Declarative rather than programmatic: every operation here is one HTTP call
 * to the connector surface, and n8n's routing property expresses that without
 * an execute() to maintain. The payoff is that adding an operation is a
 * description entry, not code — and that n8n can render the fields, run the
 * expressions and handle the pagination itself.
 */
export class Soloops implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Soloops',
    name: 'soloops',
    icon: 'file:soloops.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Read and write leads, projects, tasks, time and notes in soloops',
    defaults: { name: 'Soloops' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'soloopsApi', required: true }],
    requestDefaults: {
      baseURL: '={{$credentials.baseUrl}}',
      url: '',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        // Shows up in the soloops log, so a stray call can be traced back.
        'X-Soloops-Client': 'n8n',
      },
    },
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Lead', value: 'lead' },
          { name: 'Note', value: 'note' },
          { name: 'Project', value: 'project' },
          { name: 'Task', value: 'task' },
          { name: 'Time Entry', value: 'time' },
        ],
        default: 'lead',
      },
      ...leadOperations,
      ...leadFields,
      ...projectOperations,
      ...projectFields,
      ...taskOperations,
      ...taskFields,
      ...timeOperations,
      ...timeFields,
      ...noteOperations,
      ...noteFields,
    ],
  }
}
