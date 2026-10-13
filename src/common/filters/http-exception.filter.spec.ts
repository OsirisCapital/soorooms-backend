import { BadRequestException, HttpStatus, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter.js';

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

function run(exception: unknown, monitoring?: { report: ReturnType<typeof vi.fn> }) {
  const json = vi.fn();
  const response = { status: vi.fn().mockReturnValue({ json }) };
  const request = { method: 'POST', url: '/x', originalUrl: '/x?y=1', user: { id: 'u1' } };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }) };
  new HttpExceptionFilter(monitoring as never).catch(exception, host as never);
  return { response, json };
}

describe('HttpExceptionFilter', () => {
  it("enregistre les erreurs 5xx sans montrer le détail interne au client", () => {
    const monitoring = { report: vi.fn() };
    const { response, json } = run(new Error('secret interne'), monitoring);
    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(JSON.stringify(json.mock.calls[0][0])).not.toContain('secret interne');
    expect(monitoring.report).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/x?y=1', status: 500, userId: 'u1' }));
  });

  it("n'enregistre pas les erreurs du client (4xx)", () => {
    const monitoring = { report: vi.fn() };
    run(new BadRequestException('mauvaise saisie'), monitoring);
    expect(monitoring.report).not.toHaveBeenCalled();
  });

  it('fonctionne sans service de surveillance', () => {
    expect(() => run(new Error('boom'))).not.toThrow();
  });
});
