import { ControlPlaneApiError, getControlPlaneClient } from '../../lib/api/client';

export const dynamic = 'force-dynamic';

interface HealthResult {
  status: 'reachable' | 'unreachable';
  baseUrl: string;
  detail: string;
  contract?: string;
  service?: string;
  uptimeSec?: number;
  statusCode?: number;
  code?: string;
}

async function checkControlPlane(): Promise<HealthResult> {
  const client = getControlPlaneClient();
  try {
    const health = await client.health();
    return {
      status: health.ok ? 'reachable' : 'unreachable',
      baseUrl: client.baseUrl,
      detail: health.ok ? 'control-plane health check returned ok=true' : 'control-plane health check returned ok=false',
      ...(typeof health.contract === 'string' ? { contract: health.contract } : {}),
      ...(typeof health.service === 'string' ? { service: health.service } : {}),
      ...(typeof health.uptimeSec === 'number' ? { uptimeSec: health.uptimeSec } : {}),
    };
  } catch (err) {
    if (err instanceof ControlPlaneApiError) {
      return {
        status: 'unreachable',
        baseUrl: client.baseUrl,
        detail: err.message,
        statusCode: err.status,
        code: err.code,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'unreachable',
      baseUrl: client.baseUrl,
      detail: message,
      code: 'network_error',
    };
  }
}

export default async function HealthPage(): Promise<JSX.Element> {
  const result = await checkControlPlane();
  const reachable = result.status === 'reachable';
  return (
    <main
      className="mx-auto max-w-2xl p-8"
      data-testid="health-page"
      data-status={result.status}
    >
      <h1 className="mb-2 text-2xl font-semibold text-ink">Control-plane health</h1>
      <p className="mb-6 text-sm text-ink-subtle">
        The web app boots against the control-plane HTTP API. This page calls <code>GET /healthz</code>{' '}
        on the server it is configured to talk to and reports the outcome.
      </p>
      <section
        className={`rounded-lg border p-4 ${
          reachable ? 'border-accent-ok/40 bg-accent-ok/10' : 'border-accent-danger/40 bg-accent-danger/10'
        }`}
        role={reachable ? 'status' : 'alert'}
        data-testid="health-result"
      >
        <h2 className="text-lg font-medium">
          {reachable ? 'Reachable' : 'Unreachable'}
        </h2>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-subtle">Base URL</dt>
          <dd className="font-mono text-ink">{result.baseUrl}</dd>
          <dt className="text-ink-subtle">Status</dt>
          <dd className="text-ink">{result.status}</dd>
          {result.contract ? (
            <>
              <dt className="text-ink-subtle">Contract</dt>
              <dd className="font-mono text-ink">{result.contract}</dd>
            </>
          ) : null}
          {result.service ? (
            <>
              <dt className="text-ink-subtle">Service</dt>
              <dd className="font-mono text-ink">{result.service}</dd>
            </>
          ) : null}
          {typeof result.uptimeSec === 'number' ? (
            <>
              <dt className="text-ink-subtle">Uptime</dt>
              <dd className="font-mono text-ink">{result.uptimeSec}s</dd>
            </>
          ) : null}
          {result.statusCode !== undefined ? (
            <>
              <dt className="text-ink-subtle">HTTP</dt>
              <dd className="font-mono text-ink">{result.statusCode}</dd>
            </>
          ) : null}
          {result.code ? (
            <>
              <dt className="text-ink-subtle">Code</dt>
              <dd className="font-mono text-ink">{result.code}</dd>
            </>
          ) : null}
          <dt className="text-ink-subtle">Detail</dt>
          <dd className="text-ink">{result.detail}</dd>
        </dl>
      </section>
    </main>
  );
}
