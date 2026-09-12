import { useAuth } from '../../auth';
import LinkedAccounts from '../../components/LinkedAccounts';

// Integration: SimpleFIN linked bank accounts. Connection management is owner/admin
// only (the underlying endpoints are gated the same way).
export default function SimpleFinIntegration() {
  const { activeBook } = useAuth();
  const canManage = activeBook?.role === 'owner' || activeBook?.role === 'admin';

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Integrations</div>
          <h1 className="title">SimpleFIN</h1>
          <p className="subtitle">Connect your banks through SimpleFIN to import transactions automatically into your review queue.</p>
        </div>
      </div>

      {canManage
        ? <LinkedAccounts />
        : <div className="card"><div className="empty">Only an owner or admin can manage bank connections for this book.</div></div>}
    </>
  );
}
