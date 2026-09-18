import React from 'react';
import { Routes, Route, Navigate,useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import LoginPage from './pages/LoginPage';
import Layout from './components/Layout';
import TaskListPage from './pages/TaskListPage';
import TaskDetailPage from './pages/TaskDetailPage';
import NotificationsPage from './pages/NotificationsPage';
import OperationalPage from './pages/OperationalPage';
import PortalModulePage from './pages/PortalModulePage';
import OrganizationPage from './pages/OrganizationPage';
import PreparedReportsPage from './pages/PreparedReportsPage';
import SavedNetworkPage,{SavedBranchPage} from './pages/SavedNetworkPage';
import ReportReviewPage from './pages/ReportReviewPage';
import AccessPage from './pages/AccessPage';
import MetricThresholdsPage from './pages/MetricThresholdsPage';
import MetricAccessPage from './pages/MetricAccessPage';
import ActivateAccountPage from './pages/ActivateAccountPage';
import ModuleReadinessPage from './pages/ModuleReadinessPage';
import PersonalDayPage from './pages/PersonalDayPage';
import ReportPublicationPage from './pages/ReportPublicationPage';

export default function App() {
  const { me, loading } = useAuth();
  const {pathname}=useLocation();
  if(pathname==='/activate-account')return <ActivateAccountPage/>;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#6b7280' }}>
        Загрузка…
      </div>
    );
  }

  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OperationalPage />} />
        <Route path="/branches/:orgId" element={<OperationalPage />} />
        {['/analytics','/bdr','/kpi'].map(path=><Route key={path} path={path} element={<PortalModulePage/>}/>)}
        <Route path="/diary" element={<PersonalDayPage/>}/>
        <Route path="/modules" element={<ModuleReadinessPage/>}/>
        <Route path="/tasks" element={<TaskListPage />} />
        <Route path="/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/organization" element={<OrganizationPage />} />
        <Route path="/access" element={<AccessPage />} />
        <Route path="/access/metrics" element={<MetricAccessPage />} />
        <Route path="/settings/thresholds" element={<MetricThresholdsPage />} />
        <Route path="/prepared-reports" element={<PreparedReportsPage />} />
        <Route path="/prepared-reports/:id/review" element={<ReportReviewPage />} />
        <Route path="/prepared-reports/:id/publish" element={<ReportPublicationPage />} />
        <Route path="/saved-network" element={<SavedNetworkPage />} />
        <Route path="/saved-network/:id" element={<SavedNetworkPage />} />
        <Route path="/saved-network/:id/branches/:itemId" element={<SavedBranchPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
