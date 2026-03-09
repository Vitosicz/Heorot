import React from "react";

import { getDefaultHomeserver, getDefaultIdentityServer, isCustomHomeserverDisabled } from "../core/config/serverDefaults";
import { AppShell } from "./components/AppShell";
import { DeviceVerificationView } from "./components/DeviceVerificationView";
import { LoginView } from "./components/LoginView";
import { SecurityRecoveryView } from "./components/SecurityRecoveryView";
import { MatrixProvider, useMatrix } from "./providers/MatrixProvider";
import "./styles/App.css";
import "./styles/composer.css";
import "./styles/channelHeader.css";
import "./styles/rightPanel.css";
import "./settings/styles.css";

function LoadingView({ label }: { label: string }): React.ReactElement {
    return (
        <div className="loading-screen">
            <div className="loading-spinner" />
            <p>{label}</p>
        </div>
    );
}

function AppRouter(): React.ReactElement {
    const matrix = useMatrix();

    if (matrix.status === "booting") {
        return <LoadingView label="Bootstrapping core..." />;
    }

    if (matrix.status === "starting") {
        return <LoadingView label="Starting Matrix session..." />;
    }

    if (matrix.status === "login_required") {
        return (
            <LoginView
                defaultHomeserver={getDefaultHomeserver(matrix.config)}
                defaultIdentityServer={getDefaultIdentityServer(matrix.config)}
                disableHomeserverInput={isCustomHomeserverDisabled(matrix.config)}
                loading={false}
                error={matrix.error}
                onLogin={matrix.login}
                onLoginWithCredentials={matrix.loginWithCredentials}
            />
        );
    }

    if (matrix.status === "security_recovery") {
        return (
            <SecurityRecoveryView
                flow={matrix.securityRecoveryFlow}
                error={matrix.error}
                onPrepareSetup={matrix.prepareSecurityRecoverySetup}
                onCompleteSetup={matrix.completeSecurityRecoverySetup}
                onRestore={matrix.completeSecurityRecovery}
                onSkip={matrix.skipSecurityRecovery}
            />
        );
    }

    if (matrix.status === "security_verification") {
        if (!matrix.client) {
            return <LoadingView label="Preparing verification..." />;
        }

        return (
            <DeviceVerificationView
                client={matrix.client}
                error={matrix.error}
                localDeviceVerified={matrix.localDeviceVerified}
                canSkip={!matrix.forceVerificationEnabled}
                onRefreshStatus={matrix.refreshDeviceVerification}
                onSkip={matrix.skipDeviceVerification}
                onLogout={matrix.logout}
            />
        );
    }

    if (matrix.status === "ready" && matrix.client) {
        return <AppShell client={matrix.client} onLogout={matrix.logout} />;
    }

    return (
        <div className="error-screen">
            <h1>Unable to start Heorot UI</h1>
            <p>{matrix.error ?? "Unknown state"}</p>
        </div>
    );
}

export function App(): React.ReactElement {
    return (
        <MatrixProvider>
            <AppRouter />
        </MatrixProvider>
    );
}
