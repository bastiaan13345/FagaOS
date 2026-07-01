import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  WORKSPACE_NAV_ITEMS,
  createMockWorkspaceShellAdapter,
  loadWorkspaceShell,
  type PermissionSet,
} from '@fagaos/workspace-shell';
import { WorkspaceShell } from '../src/components/workspace-shell';

const permissions: PermissionSet = WORKSPACE_NAV_ITEMS.reduce<PermissionSet>((acc, item) => {
  acc[item.id] = 'allow';
  return acc;
}, {} as PermissionSet);

describe('WorkspaceShell', () => {
  it('renders every persistent navigation item defined by @fagaos/workspace-shell', async () => {
    const adapter = createMockWorkspaceShellAdapter({ permissions });
    const snapshot = await loadWorkspaceShell(adapter, { activeView: 'dashboard' });

    render(<WorkspaceShell snapshot={snapshot} />);

    const nav = screen.getByTestId('workspace-nav');
    for (const item of WORKSPACE_NAV_ITEMS) {
      const link = within(nav).getByRole('link', { name: item.label });
      expect(link).toHaveAttribute('href', item.href);
      expect(link.dataset['navId']).toBe(item.id);
    }
  });

  it('marks the active view with aria-current="page"', async () => {
    const adapter = createMockWorkspaceShellAdapter({ permissions });
    const snapshot = await loadWorkspaceShell(adapter, { activeView: 'agents' });

    render(<WorkspaceShell snapshot={snapshot} />);

    const nav = screen.getByTestId('workspace-nav');
    const active = within(nav).getByRole('link', { name: 'Agents' });
    expect(active).toHaveAttribute('aria-current', 'page');
    const dashboardLink = within(nav).getByRole('link', { name: 'Dashboard' });
    expect(dashboardLink).not.toHaveAttribute('aria-current');
  });

  it('renders the empty state for the active view when its read model is empty', async () => {
    const adapter = createMockWorkspaceShellAdapter({ permissions });
    const snapshot = await loadWorkspaceShell(adapter, { activeView: 'agents' });

    render(<WorkspaceShell snapshot={snapshot} />);

    const empty = screen.getByTestId('view-state-agents');
    expect(empty.dataset['state']).toBe('empty');
    expect(empty).toHaveTextContent('No agents configured');
  });

  it('renders the error state when a read model fails and still keeps the nav reachable', async () => {
    const adapter = createMockWorkspaceShellAdapter({
      permissions,
      failures: {
        sessions: new Error('control-plane read model unavailable'),
      },
    });
    const snapshot = await loadWorkspaceShell(adapter, { activeView: 'sessions' });

    render(<WorkspaceShell snapshot={snapshot} />);

    const errored = screen.getByTestId('view-state-sessions');
    expect(errored.dataset['state']).toBe('error');
    expect(errored).toHaveTextContent('control-plane read model unavailable');

    const nav = screen.getByTestId('workspace-nav');
    expect(within(nav).getByRole('link', { name: 'Audit Log' })).toBeInTheDocument();
  });

  it('renders the permission-denied state when a view is denied', async () => {
    const deniedPermissions: PermissionSet = { ...permissions, settings: 'deny' };
    const adapter = createMockWorkspaceShellAdapter({ permissions: deniedPermissions });
    const snapshot = await loadWorkspaceShell(adapter, { activeView: 'settings' });

    render(<WorkspaceShell snapshot={snapshot} />);

    const denied = screen.getByTestId('view-state-settings');
    expect(denied.dataset['state']).toBe('permission_denied');
    expect(denied).toHaveTextContent('Permission required');
  });
});
