import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  SecretStore,
} from '@waleed/hub-core';

export class FakeProcessRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  constructor(
    private readonly result: ProcessResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
      outcome: 'exited',
    },
  ) {}
  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return { ...this.result };
  }
}

export class FakeSecretStore implements SecretStore {
  readonly writes: string[] = [];
  #values = new Map<string, string>();
  async put(id: string, value: string) {
    this.#values.set(id, value);
    this.writes.push(id);
  }
  async has(id: string) {
    return this.#values.has(id);
  }
  async resolve(id: string) {
    const value = this.#values.get(id);
    if (value === undefined)
      throw new Error('Synthetic secret reference is missing.');
    return value;
  }
  async delete(id: string) {
    this.#values.delete(id);
  }
}
