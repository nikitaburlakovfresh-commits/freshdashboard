import React from 'react';
import { Routes, Route, Navigate,useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import RolePermissionsPage from './pages/RolePermissionsPage';
import RegistrationRequestsPage from './pages/RegistrationRequestsPage';
import Layout from './components/Layout';
import TaskListPage from './pages/TaskListPage';
import TaskDetailPage from './pages/TaskDetailPage';
import NotificationsPage from './pages/NotificationsPage';
import OperationalPage from './pages/OperationalPage';
import { ReportDateProvider } from './state/reportDate';
import PortalModulePage from './pages/PortalModulePage';
import OrganizationPage from './pages/OrganizationPage';
import PreparedReportsPage from './pages/PreparedReportsPage';
import SavedNetworkPage,{SavedBranchPage} from './pages/SavedNetworkPage';
import ReportReviewPage from './pages/ReportReviewPage';
import AccessPage from './pages/AccessPage';
import MetricThresholdsPage from './pages/MetricThresholdsPage';
import SourceNamingPage from './pages/SourceNamingPage';
import NotificationSettingsPage from './pages/NotificationSettingsPage';
import DivisionSummaryPage from './pages/DivisionSummaryPage';
import BranchCardPage from './pages/BranchCardPage';
import MyDeviationTasksPage from './pages/MyDeviationTasksPage';
import MetricAccessPage from './pages/MetricAccessPage';
import ActivateAccountPage from './pages/ActivateAccountPage';
import ModuleReadinessPage from './pages/ModuleReadinessPage';
import PersonalDayPage from './pages/PersonalDayPage';
import ReportPublicationPage from './pages/ReportPublicationPage';
import NetworkScorePage from './pages/NetworkScorePage';
import ScoringModelPage from './pages/ScoringModelPage';
import FocusConfigPage from './pages/FocusConfigPage';

export default function App() {
  const { me, loading } = useAuth();
  const {pathname}=useLocation();
  if(pathname==='/activate-account')return <ActivateAccountPage/>;
  // Регистрация открыта до входа: человека ещё нет в портале.
  if(pathname==='/register')return <RegisterPage/>;

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
    <ReportDateProvider><Layout>
      <Routes>
        <Route path="/" element={<NetworkScorePage />} />
        <Route path="/operational" element={<OperationalPage />} />
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
        <Route path="/access/roles" element={<RolePermissionsPage />} />
        <Route path="/access/registrations" element={<RegistrationRequestsPage />} />
        <Route path="/division-summary" element={<DivisionSummaryPage />} />
        {/* Обзор KPI живёт на главной; прежний адрес сохранён как переход,
            чтобы закладки руководителей не ломались. */}
        <Route path="/network-overview" element={<Navigate to="/" replace />} />
        <Route path="/settings/scoring" element={<ScoringModelPage />} />
        <Route path="/settings/focus" element={<FocusConfigPage />} />
        <Route path="/settings/thresholds" element={<MetricThresholdsPage />} />
        <Route path="/settings/source-naming" element={<SourceNamingPage />} />
        <Route path="/settings/notifications" element={<NotificationSettingsPage />} />
        <Route path="/branch-card/:id" element={<BranchCardPage />} />
        <Route path="/my-deviations" element={<MyDeviationTasksPage />} />
        <Route path="/prepared-reports" element={<PreparedReportsPage />} />
        <Route path="/prepared-reports/:id/review" element={<ReportReviewPage />} />
        <Route path="/prepared-reports/:id/publish" element={<ReportPublicationPage />} />
        <Route path="/saved-network" element={<SavedNetworkPage />} />
        <Route path="/saved-network/:id" element={<SavedNetworkPage />} />
        <Route path="/saved-network/:id/branches/:itemId" element={<SavedBranchPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout></ReportDateProvider>
  );
}
