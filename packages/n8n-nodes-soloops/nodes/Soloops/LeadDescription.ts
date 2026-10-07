import type { INodeProperties } from 'n8n-workflow'

/**
 * The lead operations.
 *
 * `routing` is what makes the declarative node work: each operation says which
 * request it is, and n8n assembles it from the fields below. `displayOptions`
 * is what keeps the panel readable — a field only appears for the operation it
 * belongs to.
 */
export const leadOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['lead'] } },
    options: [
      {
        name: 'Create',
        value: 'create',
        action: 'Create a lead',
        routing: { request: { method: 'POST', url: '/api/automations/connector/leads' } },
      },
      {
        name: 'Get',
        value: 'get',
        action: 'Get a lead',
        routing: {
          request: {
            method: 'GET',
            url: '=/api/automations/connector/leads/{{$parameter.leadId}}',
          },
        },
      },
      {
        name: 'Get Many',
        value: 'getMany',
        action: 'Get many leads',
        routing: { request: { method: 'GET', url: '/api/automations/connector/leads' } },
      },
      {
        name: 'Log Activity',
        value: 'logActivity',
        action: 'Log an activity on a lead',
        routing: {
          request: {
            method: 'POST',
            url: '=/api/automations/connector/leads/{{$parameter.leadId}}/activity',
          },
        },
      },
      {
        name: 'Set Stage',
        value: 'setStage',
        action: 'Move a lead to another stage',
        routing: {
          request: {
            method: 'POST',
            url: '=/api/automations/connector/leads/{{$parameter.leadId}}/stage',
          },
        },
      },
      {
        name: 'Update',
        value: 'update',
        action: 'Update a lead',
        routing: {
          request: {
            method: 'PATCH',
            url: '=/api/automations/connector/leads/{{$parameter.leadId}}',
          },
        },
      },
    ],
    default: 'create',
  },
]

const STAGES = [
  { name: 'Neu', value: 'NEW' },
  { name: 'Qualifiziert', value: 'QUALIFIED' },
  { name: 'Angebot', value: 'PROPOSAL' },
  { name: 'Verhandlung', value: 'NEGOTIATION' },
  { name: 'Gewonnen', value: 'WON' },
  { name: 'Verloren', value: 'LOST' },
]

export const leadFields: INodeProperties[] = [
  // --- The id, for everything that addresses one lead ----------------------
  {
    displayName: 'Lead ID',
    name: 'leadId',
    type: 'string',
    required: true,
    default: '',
    description: 'From a Soloops Trigger this is {{ $json.data.id }}',
    displayOptions: {
      show: { resource: ['lead'], operation: ['get', 'update', 'setStage', 'logActivity'] },
    },
  },

  // --- Create --------------------------------------------------------------
  {
    displayName: 'Title',
    name: 'title',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['lead'], operation: ['create'] } },
    routing: { send: { type: 'body', property: 'title' } },
  },
  {
    displayName: 'Additional Fields',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Field',
    default: {},
    displayOptions: { show: { resource: ['lead'], operation: ['create', 'update'] } },
    options: [
      {
        displayName: 'Company',
        name: 'company',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'company' } },
      },
      {
        displayName: 'Contact Email',
        name: 'contactEmail',
        type: 'string',
        placeholder: 'name@example.com',
        default: '',
        routing: { send: { type: 'body', property: 'contactEmail' } },
      },
      {
        displayName: 'Contact Name',
        name: 'contactName',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'contactName' } },
      },
      {
        displayName: 'Expected Close On',
        name: 'expectedCloseOn',
        type: 'dateTime',
        default: '',
        routing: { send: { type: 'body', property: 'expectedCloseOn' } },
      },
      {
        displayName: 'Notes',
        name: 'notes',
        type: 'string',
        typeOptions: { rows: 3 },
        default: '',
        routing: { send: { type: 'body', property: 'notes' } },
      },
      {
        displayName: 'Phone',
        name: 'phone',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'phone' } },
      },
      {
        displayName: 'Probability (%)',
        name: 'probability',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 100 },
        default: 0,
        routing: { send: { type: 'body', property: 'probability' } },
      },
      {
        displayName: 'Project ID',
        name: 'projectId',
        type: 'string',
        default: '',
        routing: { send: { type: 'body', property: 'projectId' } },
      },
      {
        displayName: 'Source',
        name: 'source',
        type: 'options',
        options: [
          { name: 'Empfehlung', value: 'REFERRAL' },
          { name: 'Website', value: 'WEBSITE' },
          { name: 'Outbound', value: 'OUTBOUND' },
          { name: 'Netzwerk', value: 'NETWORK' },
          { name: 'Event', value: 'EVENT' },
          { name: 'Sonstiges', value: 'OTHER' },
        ],
        default: 'OTHER',
        routing: { send: { type: 'body', property: 'source' } },
      },
      {
        displayName: 'Title',
        name: 'title',
        type: 'string',
        default: '',
        // Only offered on update — on create it is the required field above.
        displayOptions: { show: { '/operation': ['update'] } },
        routing: { send: { type: 'body', property: 'title' } },
      },
      {
        displayName: 'Value (Cents)',
        name: 'valueCents',
        type: 'number',
        default: 0,
        description: 'In cents, so 150000 is 1.500 EUR',
        routing: { send: { type: 'body', property: 'valueCents' } },
      },
    ],
  },

  // --- Set stage -----------------------------------------------------------
  {
    displayName: 'Stage',
    name: 'stage',
    type: 'options',
    options: STAGES,
    default: 'QUALIFIED',
    required: true,
    displayOptions: { show: { resource: ['lead'], operation: ['setStage'] } },
    routing: { send: { type: 'body', property: 'stage' } },
  },
  {
    displayName: 'Note',
    name: 'note',
    type: 'string',
    default: '',
    description: 'Ends up in the lead history alongside the stage change',
    displayOptions: { show: { resource: ['lead'], operation: ['setStage'] } },
    routing: { send: { type: 'body', property: 'note' } },
  },

  // --- Log activity --------------------------------------------------------
  {
    displayName: 'Kind',
    name: 'kind',
    type: 'options',
    options: [
      { name: 'Notiz', value: 'NOTE' },
      { name: 'Anruf', value: 'CALL' },
      { name: 'Mail', value: 'MAIL' },
      { name: 'Meeting', value: 'MEETING' },
      { name: 'Angebot', value: 'OFFER' },
    ],
    default: 'NOTE',
    displayOptions: { show: { resource: ['lead'], operation: ['logActivity'] } },
    routing: { send: { type: 'body', property: 'kind' } },
  },
  {
    displayName: 'Body',
    name: 'body',
    type: 'string',
    typeOptions: { rows: 3 },
    required: true,
    default: '',
    displayOptions: { show: { resource: ['lead'], operation: ['logActivity'] } },
    routing: { send: { type: 'body', property: 'body' } },
  },

  // --- Get many ------------------------------------------------------------
  {
    displayName: 'Filters',
    name: 'additionalFields',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['lead'], operation: ['getMany'] } },
    options: [
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 200 },
        default: 50,
        routing: { send: { type: 'query', property: 'limit' } },
      },
      {
        displayName: 'Only Open',
        name: 'openOnly',
        type: 'boolean',
        default: true,
        description: 'Whether to leave out leads that are already won or lost',
        routing: { send: { type: 'query', property: 'openOnly' } },
      },
      {
        displayName: 'Project ID',
        name: 'projectId',
        type: 'string',
        default: '',
        routing: { send: { type: 'query', property: 'projectId' } },
      },
      {
        displayName: 'Stage',
        name: 'stage',
        type: 'options',
        options: STAGES,
        default: 'NEW',
        routing: { send: { type: 'query', property: 'stage' } },
      },
    ],
  },
]
