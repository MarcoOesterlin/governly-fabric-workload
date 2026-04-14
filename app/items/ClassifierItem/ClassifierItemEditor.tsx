import React from 'react';
import { WorkloadClientAPI } from '@ms-fabric/workload-client';

interface ClassifierItemEditorProps {
  workloadClient: WorkloadClientAPI;
}

const ClassifierItemEditor: React.FC<ClassifierItemEditorProps> = ({ workloadClient }) => {
  return (
    <div>
      <h1>Governly – Data Classifier</h1>
      <p>Bulk-apply Microsoft Purview sensitivity labels across Fabric.</p>
    </div>
  );
};

export default ClassifierItemEditor;
