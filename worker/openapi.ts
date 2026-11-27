// OpenAPI 3.1 description of the agent API, served at /api/openapi.json.
import { FRAMINGS, MOVES, TIMES } from './agent.ts';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const idOrName = (what: string) => ({ type: 'string', description: `The ${what}'s id, or its name (matched ignoring case).` });
const prodId = { name: 'productionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const version = {
  name: 'version',
  in: 'query',
  required: false,
  schema: { type: 'integer' },
  description: 'Optional. Only change the production if it is still at this version (409 otherwise). Without it, the change is applied to the latest version.',
};
const errors = {
  '400': { description: 'Invalid input; `error` says what to fix.', content: { 'application/json': { schema: ref('Error') } } },
  '401': { description: 'No valid API token.', content: { 'application/json': { schema: ref('Error') } } },
  '404': { description: 'No such production or item (or not yours).', content: { 'application/json': { schema: ref('Error') } } },
  '409': { description: 'The production changed (with `version`), or is being changed right now: read the outline again and retry.', content: { 'application/json': { schema: ref('Error') } } },
};
const changed = (schema: object, status = '200') => ({
  [status]: {
    description: 'Done. `production.version` is the new version.',
    content: { 'application/json': { schema: { type: 'object', properties: { ...schema, production: ref('ProductionSummary'), created: ref('Created') } } } },
  },
  ...errors,
});
const body = (schema: object) => ({ required: true, content: { 'application/json': { schema } } });

const shotInput = {
  type: 'object',
  properties: {
    number: { type: 'string', description: 'Shot number, e.g. "3" or "2A". Default: next in the scene.' },
    framing: { type: 'string', enum: FRAMINGS, default: 'Medium' },
    movement: { type: 'string', enum: MOVES, default: 'Static', description: 'Camera movement.' },
    duration: { type: 'integer', minimum: 0, maximum: 600, default: 5, description: 'Seconds.' },
    location: idOrName('location (default: the scene setup\'s `location`)'),
    characters: { type: 'array', items: idOrName('character'), description: 'Who is on screen.' },
    props: { type: 'array', items: idOrName('object'), description: 'Objects in the shot (not outfits: use wardrobe).' },
    description: { type: 'string', description: 'What we see and hear. Written into the video prompt.' },
    wardrobe: ref('WardrobeInput'),
    continues: { type: 'boolean', default: false, description: 'One camera take carried on from the shot before it: its clip starts on that clip\'s last frame.' },
  },
};

export const OPENAPI = {
  openapi: '3.1.0',
  info: {
    title: 'Drama Club agent API',
    version: '1',
    description: [
      'Set up productions on Drama Club: cast, locations, props and outfits, episodes, scenes and shots, and who wears what.',
      '',
      'Authenticate with a personal API token (account menu → API tokens…): `Authorization: Bearer dc_…`. A token acts as its owner, on their productions.',
      '',
      'Start with `GET /api/productions` and `GET /api/productions/{id}/outline`. To set up a scene in one call, use `POST /api/productions/{id}/scenes`: characters, locations, props, outfits and episodes are matched by id or name, and created when missing (set `createMissing: false` to refuse instead); the response lists what was created.',
      '',
      'Changes show in the app when it next loads the production; a tab with it open offers to load the new version. Pictures and clips are made in the app.',
    ].join('\n'),
  },
  servers: [{ url: '/' }],
  security: [{ token: [] }],
  paths: {
    '/api/productions': {
      get: {
        operationId: 'listProductions',
        summary: 'List your productions',
        responses: { '200': { description: 'Newest first.', content: { 'application/json': { schema: { type: 'object', properties: { productions: { type: 'array', items: ref('ProductionSummary') } } } } } }, '401': errors['401'] },
      },
    },
    '/api/productions/{productionId}/outline': {
      get: {
        operationId: 'getOutline',
        summary: 'Read a production: cast, places, props, episodes with their scenes and shots, and wardrobe',
        description: 'Every item has an `id` to use in other calls. `wearing` on a shot is what each character wears there after episode → scene → shot overrides.',
        parameters: [prodId],
        responses: { '200': { description: 'The outline.', content: { 'application/json': { schema: { type: 'object', properties: { production: ref('ProductionSummary'), outline: ref('Outline') } } } } }, '401': errors['401'], '404': errors['404'] },
      },
    },
    '/api/productions/{productionId}/scenes': {
      post: {
        operationId: 'setUpScene',
        summary: 'Set up a scene in one call: its shots, cast, location and outfits',
        description: 'Adds a scene (numbered next in its episode unless `number` is given) with its shots in order. Names are matched to existing items and created when missing.',
        parameters: [prodId, version],
        requestBody: body({
          type: 'object',
          properties: {
            episode: idOrName('episode (created by title if missing)'),
            number: { type: 'integer', description: 'Scene number. Default: next in the episode.' },
            time: { type: 'string', enum: TIMES, default: 'DAY' },
            description: { type: 'string', description: 'What happens.' },
            location: idOrName('location every shot uses unless it says otherwise'),
            wardrobe: ref('WardrobeInput'),
            shots: { type: 'array', maxItems: 100, items: shotInput },
            createMissing: { type: 'boolean', default: true, description: 'Create characters, locations, props, outfits and episodes named but not found. False: refuse instead.' },
          },
          example: {
            episode: 'Opening Night',
            time: 'NIGHT',
            description: 'The lights fail mid-performance.',
            location: 'School hall',
            wardrobe: { Maya: 'Stage blacks' },
            shots: [
              { framing: 'Wide', characters: ['Theo', 'Jules'], description: 'The stage goes dark mid-line.', duration: 4 },
              { framing: 'Close-up', characters: ['Maya'], description: 'Maya grabs a torch in the wings.', props: ['Torch'] },
            ],
          },
        }),
        responses: changed({ scene: ref('Scene') }, '201'),
      },
    },
    '/api/productions/{productionId}/shots': {
      post: {
        operationId: 'addShot',
        summary: 'Add a shot to a scene',
        parameters: [prodId, version],
        requestBody: body({ allOf: [{ type: 'object', required: ['scene'], properties: { scene: { type: 'string', description: "The scene's id." }, createMissing: { type: 'boolean', default: true } } }, shotInput] }),
        responses: changed({ shot: ref('Shot') }, '201'),
      },
    },
    '/api/productions/{productionId}/characters': {
      post: {
        operationId: 'addCharacter',
        summary: 'Add a character',
        parameters: [prodId, version],
        requestBody: body({
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string' },
            description: { type: 'string', description: 'Who they are.' },
            appearance: { type: 'string', description: 'Age, build, hair, face, usual clothes. Repeated word for word in every video prompt they are in.' },
            actor: { type: 'string', description: 'Who plays them.' },
          },
        }),
        responses: changed({ character: ref('Character') }, '201'),
      },
    },
    '/api/productions/{productionId}/locations': {
      post: {
        operationId: 'addLocation',
        summary: 'Add a location',
        parameters: [prodId, version],
        requestBody: body({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, setting: { type: 'string', enum: ['INT', 'EXT'], default: 'INT' }, description: { type: 'string' } } }),
        responses: changed({ location: ref('Location') }, '201'),
      },
    },
    '/api/productions/{productionId}/props': {
      post: {
        operationId: 'addProp',
        summary: 'Add an object or an outfit',
        description: 'Outfits are props of kind Outfit. Anyone can wear any outfit; `usuallyWornBy` is only a default.',
        parameters: [prodId, version],
        requestBody: body({
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['Object', 'Outfit'], default: 'Object' }, description: { type: 'string' }, usuallyWornBy: idOrName('character') },
        }),
        responses: changed({ prop: ref('Prop') }, '201'),
      },
    },
    '/api/productions/{productionId}/episodes': {
      post: {
        operationId: 'addEpisode',
        summary: 'Add an episode',
        parameters: [prodId, version],
        requestBody: body({
          type: 'object',
          required: ['title'],
          properties: { title: { type: 'string' }, number: { type: 'integer', description: 'Default: next.' }, description: { type: 'string' }, style: { type: 'string', description: 'Video look, e.g. "35mm film, warm stage lighting".' } },
        }),
        responses: changed({ episode: ref('Episode') }, '201'),
      },
    },
    '/api/productions/{productionId}/wardrobe': {
      put: {
        operationId: 'setWardrobe',
        summary: 'Say what a character wears in an episode, scene or shot',
        description: 'An episode dresses its scenes and shots, a scene overrides it for its shots, a shot overrides both. `outfit`: an outfit (id or name), "usual" for their own clothes, or "inherit" to go back to what the level above says.',
        parameters: [prodId, version],
        requestBody: body({
          type: 'object',
          required: ['at', 'character', 'outfit'],
          properties: { at: { type: 'string', description: 'Id of an episode, scene or shot.' }, character: idOrName('character'), outfit: { type: 'string', description: 'Outfit id or name, "usual", or "inherit".' } },
        }),
        responses: changed({ wardrobe: { type: 'array', items: ref('WardrobeEntry') } }),
      },
    },
    '/api/productions/{productionId}/items/{itemId}': {
      patch: {
        operationId: 'editItem',
        summary: 'Change an item',
        description: [
          'Editable fields by kind:',
          '- character: name, description, appearance, actor',
          '- location: name, setting, description',
          '- prop: name, kind, description, usuallyWornBy',
          '- episode: title, number, description, style',
          '- scene: number, time, description, episode (id/title, or null)',
          '- shot: number, framing, movement, duration, location, characters, props, description, continuesPreviousShot',
          'Lists (characters, props) replace the old list.',
        ].join('\n'),
        parameters: [prodId, { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }, version],
        requestBody: body({ type: 'object', additionalProperties: true }),
        responses: changed({ item: { type: 'object' } }),
      },
      delete: {
        operationId: 'deleteItem',
        summary: 'Delete an item and every reference to it',
        description: "Deleting a scene deletes its shots; deleting an episode keeps its scenes. Pictures on the item go with it.",
        parameters: [prodId, { name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }, version],
        responses: changed({ deleted: { type: 'string' } }),
      },
    },
  },
  components: {
    securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'A Drama Club API token (dc_…), from the account menu → API tokens…' } },
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' } } },
      Named: { type: ['object', 'null'], properties: { id: { type: 'string' }, name: { type: 'string' } } },
      ProductionSummary: {
        type: 'object',
        properties: { id: { type: 'string' }, title: { type: 'string' }, version: { type: 'integer' }, nodeCount: { type: 'integer' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' } },
      },
      Created: {
        type: 'object',
        description: 'Items created because they were named but not found.',
        properties: Object.fromEntries(['characters', 'locations', 'props', 'episodes'].map((k) => [k, { type: 'array', items: ref('Named') }])),
      },
      WardrobeInput: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'What characters wear here: { "<character id or name>": "<outfit id or name>" | "usual" }. Outfits named but missing are created.',
      },
      WardrobeEntry: { type: 'object', properties: { character: ref('Named'), outfit: { oneOf: [ref('Named'), { type: 'string', const: 'usual clothes' }] } } },
      Character: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, actor: { type: 'string' }, description: { type: 'string' }, appearance: { type: 'string' }, pictures: { type: 'integer' } } },
      Location: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, setting: { type: 'string', enum: ['INT', 'EXT'] }, description: { type: 'string' }, pictures: { type: 'integer' } } },
      Prop: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string', enum: ['Object', 'Outfit'] }, description: { type: 'string' }, usuallyWornBy: ref('Named'), pictures: { type: 'integer' } } },
      Shot: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          number: { type: 'string' },
          framing: { type: 'string', enum: FRAMINGS },
          movement: { type: 'string', enum: MOVES },
          duration: { type: 'integer' },
          location: ref('Named'),
          characters: { type: 'array', items: ref('Named') },
          props: { type: 'array', items: ref('Named') },
          wearing: { type: 'array', description: 'Resolved: what each character wears in this shot, and which level set it.', items: { type: 'object', properties: { character: ref('Named'), outfit: ref('Named'), from: { type: 'string', enum: ['shot', 'scene', 'episode'] } } } },
          wardrobe: { type: 'array', items: ref('WardrobeEntry'), description: "Set on this shot itself." },
          description: { type: 'string' },
          continuesPreviousShot: { type: 'boolean' },
          frames: { type: 'integer', description: 'Storyboard frames (pictures).' },
          hasClip: { type: 'boolean', description: 'A finished clip has been added (its last frame is kept).' },
        },
      },
      Scene: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          number: { type: 'integer' },
          time: { type: 'string', enum: TIMES },
          description: { type: 'string' },
          episode: { type: ['object', 'null'], properties: { id: { type: 'string' }, number: { type: 'integer' }, title: { type: 'string' } } },
          wardrobe: { type: 'array', items: ref('WardrobeEntry') },
          shots: { type: 'array', items: ref('Shot') },
        },
      },
      Episode: {
        type: 'object',
        properties: { id: { type: 'string' }, number: { type: 'integer' }, title: { type: 'string' }, description: { type: 'string' }, style: { type: 'string' }, wardrobe: { type: 'array', items: ref('WardrobeEntry') }, scenes: { type: 'array', items: ref('Scene') } },
      },
      Outline: {
        type: 'object',
        properties: {
          characters: { type: 'array', items: ref('Character') },
          locations: { type: 'array', items: ref('Location') },
          props: { type: 'array', items: ref('Prop') },
          episodes: { type: 'array', items: ref('Episode') },
          scenesWithoutEpisode: { type: 'array', items: ref('Scene') },
          shotsWithoutScene: { type: 'array', items: ref('Shot') },
        },
      },
    },
  },
} as const;
