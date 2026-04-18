import { createBrowserHistory } from "history";
import React from "react";
import { createRoot } from 'react-dom/client';

import { FluentProvider } from "@fluentui/react-components";
import { createWorkloadClient, InitParams } from '@ms-fabric/workload-client';

import { fabricLightTheme } from "./theme";
import { App } from "./App";

export async function initialize(params: InitParams) {
    console.log('🚀 UI initialization started with params:', params);

    const workloadClient = createWorkloadClient();
    console.log('✅ WorkloadClient created successfully');

    const history = createBrowserHistory();
    console.log('✅ Browser history created, initial path:', history.location.pathname);

    history.listen((location, action) => {
        console.log(`🔄 History changed [${action}]: ${location.pathname}`);
    });

    workloadClient.navigation.onNavigate((route) => {
        const hint = route.workspaceObjectIdHint ?? 'none';
        console.log(`NAV: ${route.targetUrl} | wsHint:${hint}`);
        let url = route.targetUrl;
        if (route.workspaceObjectIdHint) {
            const separator = url.includes('?') ? '&' : '?';
            url = `${url}${separator}wsId=${route.workspaceObjectIdHint}`;
        }
        history.push(url);
    });

    workloadClient.action.onAction(async function ({ action }) {
        console.log(`ACTION: ${action}`);
        switch (action) {
            case 'item.tab.onInit':
                return { title: 'Governly' };
            case 'item.tab.canDeactivate':
                return { canDeactivate: true };
            case 'item.tab.onDeactivate':
                return {};
            case 'item.tab.canDestroy':
                return { canDestroy: true };
            case 'item.tab.onDestroy':
                return {};
            case 'item.tab.onDelete':
                return {};
            default:
                console.log(`Unknown action: ${action}`);
                return {};
        }
    });

    const rootElement = document.getElementById('root');
    if (!rootElement) {
        console.error('❌ Root element not found!');
        document.body.innerHTML = '<div style="padding: 20px; color: red;">❌ Error: Root element not found</div>';
        return;
    }

    try {
        const root = createRoot(rootElement);
        root.render(
            <FluentProvider theme={fabricLightTheme}>
                <App history={history} workloadClient={workloadClient} />
            </FluentProvider>
        );
        console.log('✅ App rendered');
    } catch (error) {
        console.error('❌ Error during React rendering:', error);
        rootElement.innerHTML = `
            <div style="padding: 20px; color: red; font-family: monospace;">
                <h2>❌ React Rendering Error</h2>
                <p>Error: ${(error as Error).message}</p>
                <pre>${(error as Error).stack}</pre>
            </div>
        `;
    }
}
