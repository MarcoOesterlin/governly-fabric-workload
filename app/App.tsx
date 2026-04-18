import React from "react";
import { Route, Router, Switch } from "react-router-dom";
import { History } from "history";
import { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { ClassifierItemEditor } from "./items/ClassifierItem";
import { ConditionalPlaygroundRoutes } from "./playground/ConditionalPlaygroundRoutes";

/*
    Add your Item Editor in the Route section of the App function below
*/

interface AppProps {
    history: History;
    workloadClient: WorkloadClientAPI;
}

export interface PageProps {
    workloadClient: WorkloadClientAPI;
    history?: History
}

export interface ContextProps {
    itemObjectId?: string;
    workspaceObjectId?: string
    source?: string;
}

export interface SharedState {
    message: string;
}

export function App({ history, workloadClient }: AppProps) {
    console.log('🎯 App component rendering, location:', history.location.pathname);

    return <Router history={history}>
        <Switch>
            {/* Editor route — Fabric navigates to {editor.path}/{itemObjectId} */}
            <Route path="/index.html/:itemObjectId">
                <ClassifierItemEditor workloadClient={workloadClient} />
            </Route>

            {/* Also match worker-initiated navigation */}
            <Route path="/ClassifierItem-editor/:itemObjectId">
                <ClassifierItemEditor workloadClient={workloadClient} />
            </Route>

            {/* Conditionally loaded playground routes (only in development) */}
            <ConditionalPlaygroundRoutes workloadClient={workloadClient} />

            {/* Catch-all: shows current path for debugging unmatched routes */}
            <Route>
                <DebugRoute />
            </Route>
        </Switch>
    </Router>;
}

function DebugRoute() {
    return (
        <div style={{ padding: 20, fontFamily: 'monospace', fontSize: 14 }}>
            <h2>⚠️ No route matched</h2>
            <p><strong>href:</strong> {window.location.href}</p>
            <p><strong>pathname:</strong> {window.location.pathname}</p>
            <p><strong>hash:</strong> {window.location.hash}</p>
            <p>Expected: <code>/ClassifierItem-editor/:itemObjectId</code></p>
        </div>
    );
}