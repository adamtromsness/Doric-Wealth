import { lazy, Suspense } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth, displayName } from './auth';
import { DoricBadge } from './components/DoricMark';
// Pages are route-split (React.lazy) so each loads on demand — this keeps the
// initial bundle small instead of shipping every screen (and its charts) up front.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Changelog = lazy(() => import('./pages/Changelog'));
const Goals = lazy(() => import('./pages/Goals'));
const Accounts = lazy(() => import('./pages/Accounts'));
const AccountDetail = lazy(() => import('./pages/AccountDetail'));
const Budgets = lazy(() => import('./pages/Budgets'));
const Categories = lazy(() => import('./pages/Categories'));
const Subscriptions = lazy(() => import('./pages/Subscriptions'));
const Reminders = lazy(() => import('./pages/Reminders'));
const SubscriptionDetail = lazy(() => import('./pages/SubscriptionDetail'));
const Transactions = lazy(() => import('./pages/Transactions'));
const Utilities = lazy(() => import('./pages/Utilities'));
const UtilityAccountDetail = lazy(() => import('./pages/UtilityAccountDetail'));
const Vehicles = lazy(() => import('./pages/Vehicles'));
const VehicleDetail = lazy(() => import('./pages/VehicleDetail'));
const Assets = lazy(() => import('./pages/Assets'));
const AssetDetail = lazy(() => import('./pages/AssetDetail'));
const OtherAssets = lazy(() => import('./pages/OtherAssets'));
const OtherLiabilities = lazy(() => import('./pages/OtherLiabilities'));
const LiabilityDetail = lazy(() => import('./pages/LiabilityDetail'));
const Properties = lazy(() => import('./pages/Properties'));
const PropertyDetail = lazy(() => import('./pages/PropertyDetail'));
const Liabilities = lazy(() => import('./pages/Liabilities'));
const Analysis = lazy(() => import('./pages/Analysis'));
const GroceryAnalysis = lazy(() => import('./pages/GroceryAnalysis'));
const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const AcceptInvite = lazy(() => import('./pages/AcceptInvite'));
const Book = lazy(() => import('./pages/Book'));
const Account = lazy(() => import('./pages/Account'));
const MyData = lazy(() => import('./pages/MyData'));
const SimpleFinIntegration = lazy(() => import('./pages/integrations/SimpleFinIntegration'));
const AiIntegration = lazy(() => import('./pages/integrations/AiIntegration'));
import { SubscriptionAlert } from './components/SubscriptionSuggestions';
import { UserMenu } from './components/UserMenu';

// Shown while a route's chunk is loading.
const PageFallback = () => <div style={{ padding: 40, color: 'var(--muted)' }}>Loading…</div>;

const nav = [
  { section: 'Overview', links: [['/', 'Dashboard'], ['/reminders', 'To-Do']] },
  {
    section: 'Track',
    links: [
      ['/transactions', 'Transactions'],
      ['/subscriptions', 'Subscriptions'],
      ['/utilities', 'Utilities'],
      ['/budgets', 'Budgets'],
      ['/goals', 'Goals'],
      ['/categories', 'Categories & Tags'],
    ],
  },
  {
    section: 'Assets',
    links: [
      ['/assets', 'Asset Dashboard'],
      ['/asset-accounts', 'Asset Accounts'],
      ['/properties', 'Properties'],
      ['/vehicles', 'Vehicles'],
      ['/other-assets', 'Other Assets'],
    ],
  },
  {
    section: 'Liabilities',
    links: [
      ['/liabilities', 'Liability Dashboard'],
      ['/liability-accounts', 'Liability Accounts'],
      ['/other-liabilities', 'Other Liabilities'],
    ],
  },
  { section: 'Insight', links: [['/analysis', 'AI Analysis'], ['/grocery-insights', 'Grocery Insights']] },
];

export default function App() {
  const { ready, user, activeBook } = useAuth();

  if (!ready) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>Loading…</div>;
  }

  // Logged out: only the auth screens are reachable.
  if (!user) {
    return (
      <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/accept" element={<AcceptInvite />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="wordmark">
          <DoricBadge size={30} className="doric-mark" />
          Doric <small>self-hosted</small>
        </div>
        {nav.map((group) => (
          <div key={group.section}>
            <div className="nav-section">{group.section}</div>
            {group.links.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === '/'} className="nav-link">
                {label}
              </NavLink>
            ))}
          </div>
        ))}
      </aside>
      <main className="main">
        <div className="topbar">
          <div className="topbar-greeting">
            Hi {displayName(user)}.{activeBook ? <> You are working on <strong>{activeBook.name}</strong>.</> : null}
          </div>
          <div className="topbar-right">
            <Link to="/changelog" className="topbar-version" title="What's new in this version">v{__APP_VERSION__}</Link>
            <UserMenu />
          </div>
        </div>
        <SubscriptionAlert />
        <Suspense fallback={<PageFallback />}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/changelog" element={<Changelog />} />
          <Route path="/goals" element={<Goals />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/budgets" element={<Budgets />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/subscriptions" element={<Subscriptions />} />
          <Route path="/reminders" element={<Reminders />} />
          <Route path="/subscriptions/:subscriptionId" element={<SubscriptionDetail />} />
          <Route path="/utilities" element={<Utilities />} />
          <Route path="/utilities/:accountId" element={<UtilityAccountDetail />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/:accountId" element={<AccountDetail />} />
          <Route path="/asset-accounts" element={<Accounts treatment="asset" />} />
          <Route path="/liability-accounts" element={<Accounts treatment="liability" />} />
          <Route path="/vehicles" element={<Vehicles />} />
          <Route path="/vehicles/:vehicleId" element={<VehicleDetail />} />
          <Route path="/assets" element={<Assets />} />
          <Route path="/other-assets" element={<OtherAssets />} />
          <Route path="/other-assets/:assetId" element={<AssetDetail />} />
          <Route path="/properties" element={<Properties />} />
          <Route path="/properties/:propertyId" element={<PropertyDetail />} />
          <Route path="/liabilities" element={<Liabilities />} />
          <Route path="/other-liabilities" element={<OtherLiabilities />} />
          <Route path="/other-liabilities/:liabilityId" element={<LiabilityDetail />} />
          <Route path="/analysis" element={<Analysis />} />
          <Route path="/grocery-insights" element={<GroceryAnalysis />} />
          <Route path="/book" element={<Book />} />
          <Route path="/account" element={<Account />} />
          <Route path="/my-data" element={<MyData />} />
          <Route path="/integrations/simplefin" element={<SimpleFinIntegration />} />
          <Route path="/integrations/ai" element={<AiIntegration />} />
          <Route path="/accept" element={<AcceptInvite />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
