const simulator = new OpenShiftSimulator();

document.addEventListener('DOMContentLoaded', function() {
    updateStatus();
    setInterval(updateStatus, 3000);

    document.getElementById('simulatedWorkloadFactor').addEventListener('input', function() {
        document.getElementById('simulatedWorkloadFactorValue').innerText = (this.value * 100).toFixed(0) + '%';
        simulator.setSimulatedWorkloadFactor(parseFloat(this.value));
        updateStatus();
    });

    document.getElementById('nodeCount').addEventListener('input', function() {
        document.getElementById('nodeCountValue').innerText = this.value;
        simulator.setTotalWorkerNodes(parseInt(this.value));
        updateStatus();
    });
});

function updateStatus() {
    const data = {
        nodes: simulator.workerNodes.map(node => node.toDict()),
        namespaces: Object.values(simulator.namespaces).map(ns => ns.toDict()),
        deployments: simulator.deployments.map(dep => dep.toDict()),
        cluster_summary: simulator.getClusterSummary(),
        simulated_workload_factor: simulator.simulatedWorkloadFactor
    };

    updateClusterSummary(data.cluster_summary, data.simulated_workload_factor);
    updateWorkerNodes(data.nodes);
    updateNamespaces(data.namespaces);
    updateDeployments(data.deployments);
}

function updateClusterSummary(summary, simulatedWorkloadFactor) {
    const summaryDiv = document.getElementById('cluster-summary');
    summaryDiv.innerHTML = `
        <table>
            <thead><tr><th>Metric</th><th>Value</th></tr></thead>
            <tbody>
                <tr><td>Total Nodes</td><td>${summary.total_nodes}</td></tr>
                <tr><td>Total CPU Capacity</td><td>${summary.total_cpu_capacity.toFixed(1)} cores</td></tr>
                <tr><td>Total Memory Capacity</td><td>${summary.total_memory_capacity.toFixed(1)} GB</td></tr>
                <tr><td>Total Reserved CPU</td><td>${summary.total_reserved_cpu.toFixed(1)} cores</td></tr>
                <tr><td>Total Reserved Memory</td><td>${summary.total_reserved_memory.toFixed(1)} GB</td></tr>
                <tr><td>Total Allocatable CPU</td><td>${summary.total_allocatable_cpu.toFixed(1)} cores</td></tr>
                <tr><td>Total Allocatable Memory</td><td>${summary.total_allocatable_memory.toFixed(1)} GB</td></tr>
                <tr><td>Total CPU Utilized</td><td>${summary.total_cpu_allocated.toFixed(1)} cores</td></tr>
                <tr><td>Total Memory Utilized</td><td>${summary.total_memory_allocated.toFixed(1)} GB</td></tr>
                <tr><td>Total CPU Available</td><td>${summary.total_cpu_available.toFixed(1)} cores</td></tr>
                <tr><td>Total Memory Available</td><td>${summary.total_memory_available.toFixed(1)} GB</td></tr>
                <tr><td>Simulated Workload Factor</td><td>${(simulatedWorkloadFactor * 100).toFixed(1)}%</td></tr>
            </tbody>
        </table>
    `;
    document.getElementById('simulatedWorkloadFactor').value = simulatedWorkloadFactor;
    document.getElementById('simulatedWorkloadFactorValue').innerText = (simulatedWorkloadFactor * 100).toFixed(0) + '%';
}

function updateWorkerNodes(nodes) {
    const nodesDiv = document.getElementById('worker-nodes');
    let html = '<table><thead><tr><th>Node</th><th>CPU (Allocatable)</th><th>Memory (Allocatable)</th><th>Deployments</th></tr></thead><tbody>';
    nodes.forEach(node => {
        html += `
            <tr>
                <td>${node.name}</td>
                <td>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${node.cpu_utilization_percent.toFixed(1)}%;">${node.cpu_utilization_percent.toFixed(1)}% (${node.cpu_allocated.toFixed(1)}/${node.allocatable_cpu.toFixed(1)} cores)</div>
                    </div>
                </td>
                <td>
                    <div class="progress-bar-container">
                        <div class="progress-bar" style="width: ${node.memory_utilization_percent.toFixed(1)}%;">${node.memory_utilization_percent.toFixed(1)}% (${node.memory_allocated.toFixed(1)}/${node.allocatable_memory.toFixed(1)} GB)</div>
                    </div>
                </td>
                <td>${node.pods.length}</td>
            </tr>
        `;
    });
    html += '</tbody></table>';
    nodesDiv.innerHTML = html;
}

function updateNamespaces(namespaces) {
    const namespacesDiv = document.getElementById('namespaces');
    let html = '<table><thead><tr><th>Namespace</th><th>CPU Quota</th><th>Memory Quota</th><th>CPU Used</th><th>Memory Used</th><th>Deployments</th></tr></thead><tbody>';
    namespaces.forEach(ns => {
        html += `
            <tr>
                <td>${ns.name}</td>
                <td>${ns.cpu_quota.toFixed(1)} cores</td>
                <td>${ns.memory_quota.toFixed(1)} GB</td>
                <td>${ns.cpu_allocated.toFixed(1)} cores</td>
                <td>${ns.memory_allocated.toFixed(1)} GB</td>
                <td>${ns.deployment_count}</td>
            </tr>
        `;
    });
    html += '</tbody></table>';
    namespacesDiv.innerHTML = html;
}

function updateDeployments(deployments) {
    const deploymentsDiv = document.getElementById('deployments');
    let html = '<table><thead><tr><th>Deployment</th><th>Namespace</th><th>Replicas</th><th>CPU/Replica</th><th>Memory/Replica</th><th>Total CPU</th><th>Total Memory</th><th>Running Pods</th><th>Actions</th></tr></thead><tbody>';
    deployments.forEach(dep => {
        html += `
            <tr>
                <td>${dep.name}</td>
                <td>${dep.namespace}</td>
                <td>
                    <input type="number" id="replicas-${dep.name}" value="${dep.replica_count}" min="0" style="width: 60px;">
                    <button onclick="scaleDeployment('${dep.name}', document.getElementById('replicas-${dep.name}').value)">Scale</button>
                </td>
                <td>${dep.cpu_request_per_replica.toFixed(1)} cores</td>
                <td>${dep.memory_request_per_replica.toFixed(1)} GB</td>
                <td>${dep.total_cpu_request.toFixed(1)} cores</td>
                <td>${dep.total_memory_request.toFixed(1)} GB</td>
                <td>${dep.running_pods}</td>
                <td><button onclick="deleteDeployment('${dep.name}')">Delete</button></td>
            </tr>
        `;
    });
    html += '</tbody></table>';
    deploymentsDiv.innerHTML = html;
}

function scaleDeployment(name, newReplicaCount) {
    if (simulator.scaleDeployment(name, parseInt(newReplicaCount))) {
        alert(`Deployment ${name} scaled to ${newReplicaCount} replicas.`);
    } else {
        alert('Failed to scale deployment: Check resources.');
    }
    updateStatus();
}

function deleteDeployment(name) {
    if (!confirm(`Are you sure you want to delete deployment ${name}?`)) return;
    if (simulator.deleteDeployment(name)) {
        alert(`Deployment ${name} deleted.`);
    } else {
        alert('Could not delete deployment.');
    }
    updateStatus();
}

function createNamespace() {
    const name = document.getElementById('namespaceName').value;
    const cpuQuota = parseFloat(document.getElementById('namespaceCpuQuota').value);
    const memoryQuota = parseFloat(document.getElementById('namespaceMemoryQuota').value);

    if (!name || isNaN(cpuQuota) || isNaN(memoryQuota) || cpuQuota <= 0 || memoryQuota <= 0) {
        alert('Please enter valid namespace details including CPU and Memory quotas.');
        return;
    }

    if (simulator.createNamespace(name, cpuQuota, memoryQuota)) {
        alert(`Namespace ${name} created.`);
        document.getElementById('namespaceName').value = '';
        document.getElementById('namespaceCpuQuota').value = '';
        document.getElementById('namespaceMemoryQuota').value = '';
    } else {
        alert(`Namespace ${name} already exists.`);
    }
    updateStatus();
}

function addDeployment() {
    const name = document.getElementById('deploymentName').value;
    const namespace = document.getElementById('deploymentNamespace').value;
    const replicas = parseInt(document.getElementById('deploymentReplicas').value);
    const cpuPerReplica = parseFloat(document.getElementById('deploymentCpuPerReplica').value);
    const memoryPerReplica = parseFloat(document.getElementById('deploymentMemoryPerReplica').value);

    if (!name || !namespace || isNaN(replicas) || replicas <= 0 || isNaN(cpuPerReplica) || cpuPerReplica <= 0 || isNaN(memoryPerReplica) || memoryPerReplica <= 0) {
        alert('Please enter valid deployment details.');
        return;
    }

    if (simulator.addDeployment(name, namespace, replicas, cpuPerReplica, memoryPerReplica)) {
        alert(`Deployment ${name} created.`);
        document.getElementById('deploymentName').value = '';
        document.getElementById('deploymentNamespace').value = '';
        document.getElementById('deploymentReplicas').value = '';
        document.getElementById('deploymentCpuPerReplica').value = '';
        document.getElementById('deploymentMemoryPerReplica').value = '';
    } else {
        alert('Could not create deployment. Check namespace or quota.');
    }
    updateStatus();
}