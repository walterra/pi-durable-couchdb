import { randomUUID } from 'node:crypto';
import { CouchDBContainer } from '@testcontainers/couchdb';
import type { TestProject } from 'vitest/node';

export interface CouchDbTestConnection {
  url: string;
  username: string;
  password: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    couchdb: CouchDbTestConnection;
  }
}

/** One disposable CouchDB per integration project, shared by its workers. */
export default async function setup(project: TestProject) {
  const container = await new CouchDBContainer('couchdb:3.5.0')
    .withUsername('durable')
    .withPassword(randomUUID())
    .start();
  try {
    // getUrl() includes credentials; pass them separately to our HTTP adapter.
    const url = new URL(container.getUrl());
    url.username = '';
    url.password = '';
    project.provide('couchdb', {
      url: url.origin,
      username: container.getUsername(),
      password: container.getPassword(),
    });
  } catch (error) {
    await container.stop();
    throw error;
  }
  return async () => { await container.stop(); };
}
