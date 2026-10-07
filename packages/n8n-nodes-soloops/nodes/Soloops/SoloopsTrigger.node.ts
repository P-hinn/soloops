import type {
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow'
// The value lives under the plural name; `NodeConnectionType` is the type.
import { NodeConnectionTypes } from 'n8n-workflow'

/**
 * The soloops trigger.
 *
 * It registers itself. On activation n8n calls `create` below, which tells
 * soloops "post this event to this URL"; on deactivation `delete` takes the
 * registration away again. That is the same shape n8n's own integrations use
 * for services with webhooks, and it is what spares anyone copying a URL from
 * one tab into another — switching the workflow on in n8n is the whole of the
 * setup.
 *
 * The consequence worth knowing: a workflow that is merely saved receives
 * nothing. soloops only posts to registrations that exist, and a registration
 * only exists while the workflow is active. The test URL works the same way,
 * which is why "Listen for test event" registers too.
 */
export class SoloopsTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Soloops Trigger',
    name: 'soloopsTrigger',
    icon: 'file:soloops.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["event"]}}',
    description: 'Starts a workflow when something happens in soloops',
    defaults: { name: 'Soloops Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: 'soloopsApi', required: true }],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Event',
        name: 'event',
        type: 'options',
        required: true,
        default: 'lead.created',
        description: 'Which soloops event starts this workflow',
        options: [
          { name: 'Lead angelegt', value: 'lead.created' },
          { name: 'Lead gewonnen', value: 'lead.won' },
          { name: 'Lead-Phase geändert', value: 'lead.stage_changed' },
          { name: 'Lead verloren', value: 'lead.lost' },
          { name: 'Wiedervorlage fällig', value: 'lead.follow_up_due' },
          { name: 'Meeting beendet', value: 'meeting.ended' },
          { name: 'Notiz angelegt', value: 'note.created' },
          { name: 'Projekt angelegt', value: 'project.created' },
          { name: 'Aufgabe erledigt', value: 'task.completed' },
        ],
      },
      {
        displayName: 'Project ID',
        name: 'projectId',
        type: 'string',
        default: '',
        description:
          'Only fire for this project. Leave empty for every project — note that a scoped trigger never receives events that belong to no project at all.',
      },
    ],
  }

  webhookMethods = {
    default: {
      /**
       * Whether soloops already posts here. n8n calls this before `create`,
       * and a true answer means activation is a no-op — which is what keeps a
       * restart of n8n from piling up duplicate registrations.
       */
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const event = this.getNodeParameter('event') as string
        const webhookUrl = this.getNodeWebhookUrl('default')
        if (!webhookUrl) return false

        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          'soloopsApi',
          {
            method: 'GET',
            baseURL: await baseUrl(this),
            url: '/api/automations/connector/triggers/by-url',
            qs: { webhookUrl, event },
            json: true,
          },
        )) as { exists?: boolean }

        return response.exists === true
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const event = this.getNodeParameter('event') as string
        const projectId = (this.getNodeParameter('projectId', '') as string) || null
        const webhookUrl = this.getNodeWebhookUrl('default')

        const response = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          'soloopsApi',
          {
            method: 'POST',
            baseURL: await baseUrl(this),
            url: '/api/automations/connector/triggers',
            body: {
              event,
              webhookUrl,
              projectId,
              // Lets soloops show the registration next to its workflow in
              // the automations view instead of as a loose URL.
              workflowId: this.getWorkflow().id,
            },
            json: true,
          },
        )) as { id?: string; secret?: string }

        // Kept in the node's own static data so `delete` has something to go
        // on even if the parameters were edited in between.
        const data = this.getWorkflowStaticData('node')
        data.triggerId = response.id
        data.secret = response.secret
        return true
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const event = this.getNodeParameter('event') as string
        const webhookUrl = this.getNodeWebhookUrl('default')
        if (!webhookUrl) return true

        try {
          await this.helpers.httpRequestWithAuthentication.call(this, 'soloopsApi', {
            method: 'DELETE',
            baseURL: await baseUrl(this),
            url: '/api/automations/connector/triggers/by-url',
            qs: { webhookUrl, event },
            json: true,
          })
        } catch {
          // Deactivation must not fail because soloops is down or the token
          // was revoked first. The stale registration posts into a dead
          // webhook, which soloops notices on its own and switches off.
          return true
        }

        const data = this.getWorkflowStaticData('node')
        delete data.triggerId
        delete data.secret
        return true
      },
    },
  }

  /**
   * What soloops posted, handed on unchanged.
   *
   * No reshaping on purpose: the envelope is documented, workflows address
   * `$json.data.…` directly, and a node that rearranged it would be a second
   * contract to keep in step with the first.
   */
  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const body = this.getBodyData()
    return { workflowData: [this.helpers.returnJsonArray([body])] }
  }
}

/** The base URL out of the credential, since the hooks assemble requests by hand. */
async function baseUrl(context: IHookFunctions): Promise<string> {
  const credentials = await context.getCredentials('soloopsApi')
  return (credentials.baseUrl as string) || 'http://api:3000'
}
