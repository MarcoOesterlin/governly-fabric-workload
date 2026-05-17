import React from "react";
import { Route, Router, Switch } from "react-router-dom";
import { History } from "history";
import { WorkloadClientAPI } from "@ms-fabric/workload-client";
import { GovernlyItemEditor } from "./items/GovernlyItem";

class ErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { error: Error | null }
> {
    constructor(props: { children: React.ReactNode }) {
        super(props);
        this.state = { error: null };
    }
    static getDerivedStateFromError(error: Error) {
        return { error };
    }
    render() {
        if (this.state.error) {
            return (
                <div style={{ padding: 20, fontFamily: 'monospace', background: '#fff2cc', border: '2px solid red', margin: 8 }}>
                    <h2 style={{ color: 'red' }}>💥 React Error Caught</h2>
                    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12 }}>
                        {this.state.error.message}{'\n\n'}{this.state.error.stack}
                    </pre>
                </div>
            );
        }
        return this.props.children;
    }
}

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
        <ErrorBoundary>
        <Switch>
            {/* Editor route — Fabric navigates to {editor.path}/{itemObjectId} */}
            <Route path="/index.html/:itemObjectId">
                <GovernlyItemEditor workloadClient={workloadClient} />
            </Route>

            {/* Also match worker-initiated navigation */}
            <Route path="/ClassifierItem-editor/:itemObjectId">
                <GovernlyItemEditor workloadClient={workloadClient} />
            </Route>

            {/* Catch-all: shows current path for debugging unmatched routes */}
            <Route>
                <DebugRoute />
            </Route>
        </Switch>
        </ErrorBoundary>
    </Router>;
}

function DebugRoute() {
    return (
        <div style={{ padding: 20, fontFamily: 'monospace', fontSize: 14, background: '#fff', color: '#000' }}>
            <h2 style={{ color: 'red' }}>⚠️ No route matched</h2>
            <p><strong>href:</strong> {window.location.href}</p>
            <p><strong>pathname:</strong> {window.location.pathname}</p>
            <p><strong>hash:</strong> {window.location.hash}</p>
            <p>Expected: <code>/index.html/:itemObjectId</code> or <code>/ClassifierItem-editor/:itemObjectId</code></p>
        </div>
    );
}