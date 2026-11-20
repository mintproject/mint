import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/layout/AppShell';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { LoginRequiredPage, ProtectedRoute } from './components/common/ProtectedRoute';
import { Toaster } from './components/ui/toaster';

// Pages — model catalog
import { AboutPage } from './pages/AboutPage';
import { AppHome } from './pages/AppHome';
import { ModelsBrowsePage } from './components/models-browse/ModelsBrowsePage';
import { RegisterPage } from './pages/RegisterPage';
import { ETLProcessRegisterPage } from './pages/ETLProcessRegisterPage';
import { ETLProcessBrowsePage } from './pages/ETLProcessBrowsePage';

// Pages — modeling
import { ModelingHome } from './pages/modeling/ModelingHome';
import { ProblemStatementsList } from './pages/modeling/ProblemStatementsList';
import { MintProblemStatement } from './pages/modeling/MintProblemStatement';
import { MintThread } from './pages/modeling/MintThread';
import { PreviousRunsPage } from './pages/modeling/PreviousRunsPage';
import { RunDiagnosticsPage } from './pages/modeling/RunDiagnosticsPage';
import { GuidedModelSetup } from './pages/modeling/GuidedModelSetup';

// Pages — datasets
import { DatasetsHome } from './pages/datasets/DatasetsHome';
import { DatasetsBrowse } from './pages/datasets/DatasetsBrowse';
import { DatasetsSearch } from './pages/datasets/DatasetsSearch';
import { DatasetDetail } from './pages/datasets/DatasetDetail';

// Pages — regions
import { RegionsHome } from './pages/regions/RegionsHome';
import { RegionsAdministrative } from './pages/regions/RegionsAdministrative';
import { RegionsHydrology } from './pages/regions/RegionsHydrology';
import { RegionsAgriculture } from './pages/regions/RegionsAgriculture';
import { RegionsManual } from './pages/regions/RegionsManual';
import { RegionsEditor } from './pages/regions/RegionsEditor';
import { RegionQueryPage } from './pages/regions/RegionQueryPage';
import { RegionRedirect } from './pages/regions/RegionRedirect';

// Pages — variables
import { VariablesHome } from './pages/variables/VariablesHome';

// Account
import { CredentialsPage } from './pages/account/CredentialsPage';

// Auth
import { OAuth2CallbackPage } from './pages/OAuth2CallbackPage';

// 404
import { NotFoundPage } from './pages/NotFoundPage';

export function App() {
  return (
    <ErrorBoundary>
      <AppShell>
        <Routes>
          {/* Home */}
          <Route path="/" element={<AppHome />} />
          <Route path="/about" element={<AboutPage />} />

          {/* Models */}
          <Route path="/models" element={<ModelsBrowsePage />} />
          <Route path="/modelconfigurations/:slugid" element={<ModelsBrowsePage />} />
          <Route
            path="/models/configure/:slugid"
            element={
              <ProtectedRoute>
                <ModelsBrowsePage editable basePath="/models/configure" />
              </ProtectedRoute>
            }
          />
          <Route
            path="/models/register"
            element={
              <ProtectedRoute>
                <RegisterPage />
              </ProtectedRoute>
            }
          />
          <Route path="/etl" element={<ETLProcessBrowsePage />} />
          <Route
            path="/etl/register"
            element={
              <ProtectedRoute>
                <ETLProcessRegisterPage />
              </ProtectedRoute>
            }
          />

          {/* Legacy configure route — redirect to models */}
          <Route path="/configure" element={<Navigate to="/models" replace />} />

          {/* Modeling */}
          <Route path="/modeling" element={<ModelingHome />} />
          <Route
            path="/modeling/problem-statements/start"
            element={
              <ProtectedRoute>
                <GuidedModelSetup />
              </ProtectedRoute>
            }
          />
          <Route
            path="/modeling/problem-statements"
            element={
              <ProtectedRoute>
                <ProblemStatementsList />
              </ProtectedRoute>
            }
          />
          <Route
            path="/modeling/problem-statement/:id"
            element={
              <ProtectedRoute>
                <MintProblemStatement />
              </ProtectedRoute>
            }
          />
          <Route
            path="/modeling/thread/:threadId/runs/:runKey/diagnostics"
            element={
              <ProtectedRoute>
                <RunDiagnosticsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/modeling/thread/:id/runs"
            element={
              <ProtectedRoute>
                <PreviousRunsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/modeling/thread/:id"
            element={
              <ProtectedRoute>
                <MintThread />
              </ProtectedRoute>
            }
          />

          {/* Account */}
          <Route
            path="/account/credentials"
            element={
              <ProtectedRoute>
                <CredentialsPage />
              </ProtectedRoute>
            }
          />

          {/* Auth callback */}
          <Route path="/oauth2/callback" element={<OAuth2CallbackPage />} />
          <Route path="/login-required" element={<LoginRequiredPage />} />

          {/* Datasets — flat routes (not nested outlet) */}
          <Route path="/datasets" element={<DatasetsHome />} />
          <Route path="/datasets/browse" element={<DatasetsBrowse />} />
          <Route path="/datasets/browse/:id" element={<DatasetsBrowse />} />
          <Route path="/datasets/search" element={<DatasetsSearch />} />
          <Route path="/datasets/detail/:id" element={<DatasetDetail />} />

          {/* Regions */}
          <Route path="/regions" element={<RegionsHome />} />
          <Route path="/regions/editor" element={<RegionsEditor />} />
          <Route path="/regions/administrative" element={<RegionsAdministrative />} />
          <Route path="/regions/hydrology" element={<RegionsHydrology />} />
          <Route path="/regions/agriculture" element={<RegionsAgriculture />} />
          <Route path="/regions/manual" element={<RegionsManual />} />
          <Route path="/regions/:id/datasets" element={<RegionQueryPage />} />
          <Route path="/regions/:id/models" element={<RegionQueryPage />} />
          {/* A bare region has no page of its own; show its models. */}
          <Route path="/regions/:id" element={<RegionRedirect />} />

          {/* Variables */}
          <Route path="/variables" element={<VariablesHome />} />

          {/* 404 */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </AppShell>
      <Toaster />
    </ErrorBoundary>
  );
}
