import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  WORKSPACE_NAV_ITEMS,
  type WorkspaceNavItem,
  type WorkspaceShellSnapshot,
  type WorkspaceViewSnapshot,
} from '@fagaos/workspace-shell';

interface WorkspaceShellProps {
  snapshot: WorkspaceShellSnapshot;
  children?: ReactNode;
}

/**
 * Top-level workspace shell. Renders the persistent navigation, the
 * dashboard summary, and the active view. The shell snapshot is
 * produced by `@fagaos/workspace-shell` so the visual contract matches
 * the core package's `renderWorkspaceShellHtml` reference renderer.
 */
export function WorkspaceShell({ snapshot, children }: WorkspaceShellProps): JSX.Element {
  const activeView = snapshot.views.find((view) => view.id === snapshot.activeView) ?? snapshot.views[0];
  return (
    <div className="workspace-shell" data-testid="workspace-shell">
      <aside className="workspace-shell__nav" aria-label="Workspace navigation">
        <Link className="workspace-shell__brand" href="/dashboard" data-testid="workspace-brand">
          FagaOS
        </Link>
        <nav data-testid="workspace-nav">
          <ul>
            {snapshot.nav.map((item) => (
              <li key={item.id}>
                <NavLink item={item} />
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <section className="workspace-shell__content">
        <DashboardSummary snapshot={snapshot} />
        {children ?? (activeView ? <ViewState view={activeView} /> : null)}
      </section>
    </div>
  );
}

function NavLink({ item }: { item: WorkspaceNavItem }): JSX.Element {
  const className = [
    'workspace-shell__nav-link',
    item.isActive ? 'is-active' : '',
    item.permission === 'deny' ? 'is-denied' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Link
      href={item.href}
      className={className}
      aria-current={item.isActive ? 'page' : undefined}
      data-permission={item.permission}
      data-nav-id={item.id}
    >
      {item.label}
    </Link>
  );
}

function DashboardSummary({ snapshot }: { snapshot: WorkspaceShellSnapshot }): JSX.Element {
  const { dashboard, degradedSources } = snapshot;
  return (
    <section
      className="workspace-shell__dashboard"
      aria-label="Workspace dashboard summary"
      data-testid="workspace-dashboard"
    >
      <article>
        <h2>Agent health</h2>
        <strong>
          {dashboard.agentHealth.active}/{dashboard.agentHealth.total}
        </strong>
        <span>{dashboard.agentHealth.degraded} degraded</span>
      </article>
      <article>
        <h2>Active tasks</h2>
        <strong>{dashboard.taskSummary.active}</strong>
        <span>{dashboard.taskSummary.waitingOnApproval} waiting approval</span>
      </article>
      <article>
        <h2>Pending approvals</h2>
        <strong>{dashboard.pendingApprovals.total}</strong>
        <span>{dashboard.pendingApprovals.urgent} urgent</span>
      </article>
      <article>
        <h2>Connected accounts</h2>
        <strong>
          {dashboard.connectedAccountHealth.healthy}/{dashboard.connectedAccountHealth.total}
        </strong>
        <span>{dashboard.connectedAccountHealth.reauthRequired} need reauth</span>
      </article>
      {degradedSources.length > 0 ? (
        <article className="workspace-shell__degraded" role="status">
          <h2>Degraded data sources</h2>
          <ul>
            {degradedSources.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function ViewState({ view }: { view: WorkspaceViewSnapshot }): JSX.Element {
  const { state } = view;
  switch (state.kind) {
    case 'loading':
      return (
        <section aria-busy="true" data-testid={`view-state-${view.id}`} data-state="loading">
          <h1>{view.label}</h1>
          <p>{state.message}</p>
        </section>
      );
    case 'empty':
      return (
        <section data-testid={`view-state-${view.id}`} data-state="empty">
          <h1>{view.label}</h1>
          <p>{state.message}</p>
        </section>
      );
    case 'error':
      return (
        <section role="alert" data-testid={`view-state-${view.id}`} data-state="error">
          <h1>{view.label}</h1>
          <p>{state.message}</p>
        </section>
      );
    case 'permission_denied':
      return (
        <section data-testid={`view-state-${view.id}`} data-state="permission_denied">
          <h1>Permission required</h1>
          <p>{state.message}</p>
        </section>
      );
    case 'ready':
      return (
        <section data-testid={`view-state-${view.id}`} data-state="ready">
          <h1>{view.label}</h1>
          <p>{state.summary}</p>
        </section>
      );
  }
}

export const WORKSPACE_NAV_LABELS = WORKSPACE_NAV_ITEMS.map((item) => item.label);
