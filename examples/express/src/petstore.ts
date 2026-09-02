export const petstore = {
  openapi: '3.0.3',
  info: {
    title: 'Petstore',
    version: '1.4.2',
    description: 'A small demo API used by the ludin examples.\n\nEndpoints tagged **Admin** are only visible to the admin role.',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/api', description: 'Same origin' }],
  tags: [
    { name: 'Pets', description: 'Everything about your pets' },
    { name: 'Auth', description: 'Endpoints that require a bearer token (use `letmein`)' },
    { name: 'Admin', description: 'Dangerous operations' },
  ],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer', format: 'int64', readOnly: true, example: 1 },
          name: { type: 'string', example: 'Mochi', minLength: 1 },
          tag: { type: 'string', enum: ['cat', 'dog', 'bird'], description: 'Kind of animal' },
          owner: { $ref: '#/components/schemas/Owner' },
          createdAt: { type: 'string', format: 'date-time', readOnly: true },
        },
      },
      Owner: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          address: { type: 'object', properties: { city: { type: 'string' }, zip: { type: 'string', pattern: '^\\d{5}$' } } },
        },
      },
      Error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'integer' }, message: { type: 'string' } } },
    },
  },
  paths: {
    '/pets': {
      get: {
        tags: ['Pets'],
        summary: 'List all pets',
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', description: 'How many items to return', schema: { type: 'integer', maximum: 100, example: 20 } }],
        responses: {
          200: { description: 'A paged array of pets', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } },
          default: { description: 'unexpected error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      post: {
        tags: ['Pets'],
        summary: 'Create a pet',
        operationId: 'createPet',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, description: 'The id of the pet', schema: { type: 'integer' }, example: 1 }],
      get: {
        tags: ['Pets'],
        summary: 'Get a pet by id',
        operationId: 'showPetById',
        responses: {
          200: { description: 'Expected response', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      delete: {
        tags: ['Pets'],
        summary: 'Delete a pet',
        operationId: 'deletePet',
        deprecated: true,
        responses: { 204: { description: 'Deleted' } },
      },
    },
    '/secure/me': {
      get: {
        tags: ['Auth'],
        summary: 'Who am I',
        operationId: 'me',
        security: [{ bearer: [] }],
        responses: { 200: { description: 'ok' }, 401: { description: 'bad token' } },
      },
    },
    '/admin/reset': {
      post: {
        tags: ['Admin'],
        summary: 'Reset the database',
        operationId: 'resetDb',
        responses: { 200: { description: 'ok' } },
      },
    },
  },
};
