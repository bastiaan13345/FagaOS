import { WorkspacePage } from '../../components/workspace-page';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage(): Promise<JSX.Element> {
  return <WorkspacePage viewId="approvals" />;
}
