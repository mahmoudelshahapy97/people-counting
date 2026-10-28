import { Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import { AuthLayout, Loading, RequireAuth } from "@insighteye/ui";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import ProductIcon from "@mui/icons-material/Groups";
import AppLayout from "../layouts/AppLayout";

// Code-split per route: the dashboard is the landing screen and has no business
// downloading chart.js before it can paint.
const Login = lazy(() => import("../pages/Login"));
const ForgotPassword = lazy(() => import("../pages/ForgotPassword"));
const Dashboard = lazy(() => import("../pages/Dashboard"));
const CameraList = lazy(() => import("../pages/cameras/CameraList"));
const CameraForm = lazy(() => import("../pages/cameras/CameraForm"));
const CameraDetail = lazy(() => import("../pages/cameras/CameraDetail"));
const Alerts = lazy(() => import("../pages/Alerts"));
const AlertDetail = lazy(() => import("../pages/AlertDetail"));
// Their own chunks, so chart.js is only downloaded by someone who opens them.
const Analytics = lazy(() => import("../pages/Analytics"));
const History = lazy(() => import("../pages/History"));
const SystemStatus = lazy(() => import("../pages/SystemStatus"));
const Users = lazy(() => import("../pages/admin/Users"));
const Workspaces = lazy(() => import("../pages/admin/Workspaces"));
const LiveWall = lazy(() => import("../pages/LiveWall"));
const Notifications = lazy(() => import("../pages/Notifications"));
const AuditLog = lazy(() => import("../pages/admin/AuditLog"));
const NotFound = lazy(() => import("../pages/NotFound"));

export function AppRouter() {
  const { t } = useTranslation();
  const product = { brand: "InsightEye", tagline: t("product.tagline"), icon: <ProductIcon /> };
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading height="60vh" />}>
        <Routes>
          <Route element={<AuthLayout product={product} />}>
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
          </Route>

          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />

            <Route path="/cameras">
              <Route index element={<CameraList />} />
              <Route
                path="new"
                element={
                  <RequireAuth perm="admin">
                    <CameraForm />
                  </RequireAuth>
                }
              />
              <Route path=":cameraId" element={<CameraDetail />} />
              <Route
                path=":cameraId/edit"
                element={
                  <RequireAuth perm="admin">
                    <CameraForm />
                  </RequireAuth>
                }
              />
            </Route>

            <Route path="/alerts">
              <Route index element={<Alerts />} />
              <Route path=":alertId" element={<AlertDetail />} />
            </Route>

            <Route path="/analytics" element={<Analytics />} />
            <Route path="/history" element={<History />} />
            <Route path="/system" element={<SystemStatus />} />

            <Route
              path="/workspaces"
              element={
                <RequireAuth perm="admin">
                  <Workspaces />
                </RequireAuth>
              }
            />

            <Route
              path="/users"
              element={
                <RequireAuth perm="admin">
                  <Users />
                </RequireAuth>
              }
            />

            {/* lost-found's name for the same page; old links still land. */}
            <Route path="/events" element={<Navigate to="/alerts" replace />} />

            <Route path="/live" element={<LiveWall />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route
              path="/audit"
              element={
                <RequireAuth perm="admin">
                  <AuditLog />
                </RequireAuth>
              }
            />

            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default AppRouter;
