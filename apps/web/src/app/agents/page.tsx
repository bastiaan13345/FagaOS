import { WorkspacePage } from '../../components/workspace-page';

export const dynamic = 'force-dynamic';

export default async function AgentsPage(): Promise<JSX.Element> {
  return <WorkspacePage viewId="agents" />;
}
