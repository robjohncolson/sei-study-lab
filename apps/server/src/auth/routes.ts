import type { FastifyInstance } from 'fastify';
import type { AuthService } from './service.js';

/** Registered within the existing Host, Origin and CSRF guards; logging stays off. */
export function registerPasswordRoutes(app: FastifyInstance, service: AuthService) {
  app.post('/api/auth/signup', async (request, reply) => {
    const result = await service.signup(request.body, request.ip);
    return reply.header('Set-Cookie', result.cookie).send({ signedIn: true });
  });
  app.post('/api/auth/login', async (request, reply) => {
    const result = await service.login(request.body, request.ip);
    return reply.header('Set-Cookie', result.cookie).send({ signedIn: true });
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const result = await service.logout(request.headers.cookie);
    return reply.header('Set-Cookie', result.cookie).send({ signedIn: false });
  });
}
