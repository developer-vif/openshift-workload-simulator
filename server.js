
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// --- Simulation Classes ---

const RESERVED_CPU = 2.0; // Cores
const RESERVED_MEMORY = 4.0; // GB

class WorkerNode {
    constructor(name, cpuCapacity, memoryCapacity) {
        this.name = name;
        this.cpuCapacity = cpuCapacity;
        this.memoryCapacity = memoryCapacity;
        this.cpuAllocated = 0;
        this.memoryAllocated = 0;
        this.pods = [];
    }

    get allocatableCpu() {
        return Math.max(0, this.cpuCapacity - RESERVED_CPU);
    }

    get allocatableMemory() {
        return Math.max(0, this.memoryCapacity - RESERVED_MEMORY);
    }

    get cpuAvailable() {
        return this.cpuCapacity - this.cpuAllocated;
    }

    get memoryAvailable() {
        return this.memoryCapacity - this.memoryAllocated;
    }

    allocateResources(cpu, memory) {
        this.cpuAllocated += cpu;
        this.memoryAllocated += memory;
        return true;
    }

    deallocateResources(cpu, memory) {
        this.cpuAllocated -= cpu;
        this.memoryAllocated -= memory;
        if (this.cpuAllocated < 0) this.cpuAllocated = 0;
        if (this.memoryAllocated < 0) this.memoryAllocated = 0;
    }

    addPod(pod) {
        this.pods.push(pod);
    }

    removePod(pod) {
        const index = this.pods.indexOf(pod);
        if (index > -1) {
            this.pods.splice(index, 1);
        }
    }

    getUtilizationPercentage(current, total) {
        return total > 0 ? (current / total) * 100 : 0;
    }

    toDict() {
        return {
            name: this.name,
            cpu_capacity: this.cpuCapacity,
            memory_capacity: this.memoryCapacity,
            allocatable_cpu: this.allocatableCpu,
            allocatable_memory: this.allocatableMemory,
            cpu_allocated: this.cpuAllocated,
            memory_allocated: this.memoryAllocated,
            cpu_utilization_percent: this.getUtilizationPercentage(this.cpuAllocated, this.allocatableCpu),
            memory_utilization_percent: this.getUtilizationPercentage(this.memoryAllocated, this.allocatableMemory),
            pods: this.pods.map(pod => pod.toDict())
        };
    }
}

class Namespace {
    constructor(name, cpuQuota, memoryQuota) {
        this.name = name;
        this.cpuQuota = cpuQuota;
        this.memoryQuota = memoryQuota;
        this.deployments = [];
        this.cpuAllocated = 0;
        this.memoryAllocated = 0;
    }

    addDeployment(deployment) {
        this.deployments.push(deployment);
    }

    removeDeployment(deployment) {
        const index = this.deployments.indexOf(deployment);
        if (index > -1) {
            this.deployments.splice(index, 1);
        }
    }

    allocateResources(cpu, memory) {
        if ((this.cpuAllocated + cpu) <= this.cpuQuota &&
            (this.memoryAllocated + memory) <= this.memoryQuota) {
            this.cpuAllocated += cpu;
            this.memoryAllocated += memory;
            return true;
        }
        return false;
    }

    deallocateResources(cpu, memory) {
        this.cpuAllocated -= cpu;
        this.memoryAllocated -= memory;
        if (this.cpuAllocated < 0) this.cpuAllocated = 0;
        if (this.memoryAllocated < 0) this.memoryAllocated = 0;
    }

    toDict() {
        return {
            name: this.name,
            cpu_quota: this.cpuQuota,
            memory_quota: this.memoryQuota,
            cpu_allocated: this.cpuAllocated,
            memory_allocated: this.memoryAllocated,
            deployment_count: this.deployments.length
        };
    }
}

class Pod {
    constructor(name, cpuRequest, memoryRequest) {
        this.name = name;
        this.cpuRequest = cpuRequest;
        this.memoryRequest = memoryRequest;
        this.status = "Pending";
        this.node = null;
    }

    toDict() {
        return {
            name: this.name,
            cpu_request: this.cpuRequest,
            memory_request: this.memoryRequest,
            status: this.status,
            node: this.node ? this.node.name : "N/A"
        };
    }
}

class Deployment {
    constructor(name, namespace, replicaCount, cpuRequestPerReplica, memoryRequestPerReplica) {
        this.name = name;
        this.namespace = namespace;
        this.replicaCount = replicaCount;
        this.cpuRequestPerReplica = cpuRequestPerReplica;
        this.memoryRequestPerReplica = memoryRequestPerReplica;
        this.pods = [];
        this.createPods();
    }

    createPods() {
        this.pods = [];
        for (let i = 0; i < this.replicaCount; i++) {
            const podName = `${this.name}-${i}`;
            this.pods.push(new Pod(podName, this.cpuRequestPerReplica, this.memoryRequestPerReplica));
        }
    }

    toDict() {
        return {
            name: this.name,
            namespace: this.namespace.name,
            replica_count: this.replicaCount,
            cpu_request_per_replica: this.cpuRequestPerReplica,
            memory_request_per_replica: this.memoryRequestPerReplica,
            total_cpu_request: this.replicaCount * this.cpuRequestPerReplica,
            total_memory_request: this.replicaCount * this.memoryRequestPerReplica,
            running_pods: this.pods.filter(pod => pod.status === "Running").length,
            pods: this.pods.map(pod => pod.toDict())
        };
    }
}

class OpenShiftSimulator {
    constructor() {
        this.workerNodes = [];
        this.namespaces = {};
        this.deployments = [];
        this.simulatedWorkloadFactor = 0.0;
        this.nodeCounter = 0;

        for (let i = 0; i < 3; i++) {
            this.addWorkerNode(undefined, 128.0, 1500.0);
        }
    }

    addWorkerNode(name, cpu = 128.0, memory = 1500.0) {
        this.nodeCounter++;
        if (!name) {
            name = `worker-node-${this.nodeCounter}`;
        }
        const node = new WorkerNode(name, cpu, memory);
        this.workerNodes.push(node);
        return node;
    }

    setTotalWorkerNodes(targetCount) {
        const currentCount = this.workerNodes.length;
        if (targetCount < currentCount) {
            const nodesToRemove = this.workerNodes.splice(targetCount);
            const podsToReallocate = [];
            nodesToRemove.forEach(node => {
                node.pods.forEach(pod => {
                    pod.node = null;
                    pod.status = "Pending";
                    podsToReallocate.push(pod);
                });
            });
            this.reallocateAllPods();
        } else if (targetCount > currentCount) {
            for (let i = 0; i < targetCount - currentCount; i++) {
                this.addWorkerNode();
            }
            this.reallocateAllPods();
        }
        return true;
    }
    
    reallocateAllPods() {
        // Deallocate all pods from all nodes
        this.workerNodes.forEach(node => {
            node.cpuAllocated = 0;
            node.memoryAllocated = 0;
            node.pods = [];
        });
    
        // Mark all pods as pending
        this.deployments.forEach(dep => {
            dep.pods.forEach(pod => {
                pod.status = "Pending";
                pod.node = null;
            });
        });
    
        // Re-allocate all pods
        this.deployments.forEach(dep => {
            this.allocateDeploymentPods(dep);
        });
    }

    createNamespace(name, cpuQuota, memoryQuota) {
        if (this.namespaces[name]) {
            return null;
        }
        const namespace = new Namespace(name, cpuQuota, memoryQuota);
        this.namespaces[name] = namespace;
        return namespace;
    }

    addDeployment(name, namespaceName, replicaCount, cpuRequestPerReplica, memoryRequestPerReplica) {
        const namespace = this.namespaces[namespaceName];
        if (!namespace) return null;

        const totalCpuNeeded = replicaCount * cpuRequestPerReplica;
        const totalMemoryNeeded = replicaCount * memoryRequestPerReplica;

        if (!namespace.allocateResources(totalCpuNeeded, totalMemoryNeeded)) {
            return null;
        }

        const deployment = new Deployment(name, namespace, replicaCount, cpuRequestPerReplica, memoryRequestPerReplica);
        this.deployments.push(deployment);
        namespace.addDeployment(deployment);
        this.allocateDeploymentPods(deployment);
        return deployment;
    }

    scaleDeployment(name, newReplicaCount) {
        const deployment = this.deployments.find(dep => dep.name === name);
        if (!deployment) return false;

        const namespace = deployment.namespace;
        const oldTotalCpu = deployment.replicaCount * deployment.cpuRequestPerReplica;
        const oldTotalMemory = deployment.replicaCount * deployment.memoryRequestPerReplica;

        const newTotalCpu = newReplicaCount * deployment.cpuRequestPerReplica;
        const newTotalMemory = newReplicaCount * deployment.memoryRequestPerReplica;

        const cpuDiff = newTotalCpu - oldTotalCpu;
        const memoryDiff = newTotalMemory - oldTotalMemory;

        namespace.deallocateResources(oldTotalCpu, oldTotalMemory);
        deployment.pods.forEach(pod => {
            if (pod.node) {
                pod.node.deallocateResources(pod.cpuRequest, pod.memoryRequest);
                pod.node.removePod(pod);
            }
        });

        deployment.replicaCount = newReplicaCount;
        deployment.createPods();

        if (!namespace.allocateResources(newTotalCpu, newTotalMemory)) {
            console.log(`Failed to scale deployment ${name}: Namespace quota exceeded.`);
            // Revert to old state (simplified)
            namespace.allocateResources(oldTotalCpu, oldTotalMemory); // Give back old resources
            return false;
        }

        this.allocateDeploymentPods(deployment);
        return true;
    }

    deleteDeployment(name) {
        const deploymentIndex = this.deployments.findIndex(dep => dep.name === name);
        if (deploymentIndex === -1) return false;

        const deployment = this.deployments[deploymentIndex];
        const namespace = deployment.namespace;
        const totalCpu = deployment.replicaCount * deployment.cpuRequestPerReplica;
        const totalMemory = deployment.replicaCount * deployment.memoryRequestPerReplica;

        namespace.deallocateResources(totalCpu, totalMemory);
        namespace.removeDeployment(deployment);

        deployment.pods.forEach(pod => {
            if (pod.node) {
                pod.node.deallocateResources(pod.cpuRequest, pod.memoryRequest);
                pod.node.removePod(pod);
            }
        });

        this.deployments.splice(deploymentIndex, 1);
        return true;
    }

    allocateDeploymentPods(deployment) {
        const sortedNodes = [...this.workerNodes].sort((a, b) => a.cpuAllocated - b.cpuAllocated);

        deployment.pods.forEach(pod => {
            if (pod.status === "Pending") {
                for (const node of sortedNodes) {
                    if (node.allocateResources(pod.cpuRequest, pod.memoryRequest)) {
                        pod.status = "Running";
                        pod.node = node;
                        node.addPod(pod);
                        break;
                    }
                }
            }
        });
    }

    setSimulatedWorkloadFactor(factor) {
        if (factor < 0.0 || factor > 1.0) return false;
        this.simulatedWorkloadFactor = factor;

        // Deallocate all pods from all nodes before clearing deployments
        this.workerNodes.forEach(node => {
            node.cpuAllocated = 0;
            node.memoryAllocated = 0;
            node.pods = [];
        });

        // Clear existing namespaces and deployments
        this.namespaces = {};
        this.deployments = [];


        if (factor > 0) {
            const totalAllocatableCpu = this.workerNodes.reduce((sum, node) => sum + node.allocatableCpu, 0);
            const totalAllocatableMemory = this.workerNodes.reduce((sum, node) => sum + node.allocatableMemory, 0);

            const numNamespaces = Math.max(1, Math.min(10, Math.ceil(factor * 10)));
            const numDeploymentsPerNs = Math.max(1, Math.min(10, Math.ceil(factor * 10)));

            const avgCpuPerNs = totalAllocatableCpu / numNamespaces;
            const avgMemoryPerNs = totalAllocatableMemory / numNamespaces;

            for (let i = 0; i < numNamespaces; i++) {
                const nsName = `sim-ns-${i}`;
                const nsCpuQuota = avgCpuPerNs * 1.2;
                const nsMemoryQuota = avgMemoryPerNs * 1.2;
                this.createNamespace(nsName, nsCpuQuota, nsMemoryQuota);

                const targetCpuForNs = (totalAllocatableCpu * factor) / numNamespaces;
                const targetMemoryForNs = (totalAllocatableMemory * factor) / numNamespaces;

                const cpuPerDeployment = targetCpuForNs / numDeploymentsPerNs;
                const memoryPerDeployment = targetMemoryForNs / numDeploymentsPerNs;

                for (let j = 0; j < numDeploymentsPerNs; j++) {
                    const depName = `sim-dep-${i}-${j}`;
                    const replicaCount = Math.floor(Math.random() * 3) + 1;
                    const cpuPerReplica = Math.max(0.01, cpuPerDeployment / replicaCount);
                    const memoryPerReplica = Math.max(0.01, memoryPerDeployment / replicaCount);
                    this.addDeployment(depName, nsName, replicaCount, cpuPerReplica, memoryPerReplica);
                }
            }
        }
        return true;
    }

    getClusterSummary() {
        const totalCpuCapacity = this.workerNodes.reduce((sum, node) => sum + node.cpuCapacity, 0);
        const totalMemoryCapacity = this.workerNodes.reduce((sum, node) => sum + node.memoryCapacity, 0);
        const totalAllocatableCpu = this.workerNodes.reduce((sum, node) => sum + node.allocatableCpu, 0);
        const totalAllocatableMemory = this.workerNodes.reduce((sum, node) => sum + node.allocatableMemory, 0);
        const totalCpuAllocated = this.workerNodes.reduce((sum, node) => sum + node.cpuAllocated, 0);
        const totalMemoryAllocated = this.workerNodes.reduce((sum, node) => sum + node.memoryAllocated, 0);

        return {
            total_nodes: this.workerNodes.length,
            total_cpu_capacity: totalCpuCapacity,
            total_memory_capacity: totalMemoryCapacity,
            total_allocatable_cpu: totalAllocatableCpu,
            total_allocatable_memory: totalAllocatableMemory,
            total_reserved_cpu: this.workerNodes.length * RESERVED_CPU,
            total_reserved_memory: this.workerNodes.length * RESERVED_MEMORY,
            total_cpu_allocated: totalCpuAllocated,
            total_memory_allocated: totalMemoryAllocated,
            total_cpu_available: totalAllocatableCpu - totalCpuAllocated,
            total_memory_available: totalAllocatableMemory - totalMemoryAllocated,
            simulated_workload_factor: this.simulatedWorkloadFactor
        };
    }
}

// --- Express App Setup ---

const simulator = new OpenShiftSimulator();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());


app.get('/', (req, res) => {
    res.render('index');
});

app.get('/api/status', (req, res) => {
    res.json({
        nodes: simulator.workerNodes.map(node => node.toDict()),
        namespaces: Object.values(simulator.namespaces).map(ns => ns.toDict()),
        deployments: simulator.deployments.map(dep => dep.toDict()),
        cluster_summary: simulator.getClusterSummary(),
        simulated_workload_factor: simulator.simulatedWorkloadFactor
    });
});

app.post('/api/set_node_count', (req, res) => {
    const { count } = req.body;
    if (simulator.setTotalWorkerNodes(parseInt(count, 10))) {
        res.json({ success: true, message: `Node count set to ${count}.` });
    } else {
        res.status(400).json({ success: false, message: "Could not set node count." });
    }
});

app.post('/api/create_namespace', (req, res) => {
    const { name, cpu_quota, memory_quota } = req.body;
    if (!name || !cpu_quota || !memory_quota) {
        return res.status(400).json({ success: false, message: "Missing data" });
    }
    if (simulator.createNamespace(name, parseFloat(cpu_quota), parseFloat(memory_quota))) {
        res.json({ success: true, message: `Namespace ${name} created.` });
    } else {
        res.status(409).json({ success: false, message: `Namespace ${name} already exists.` });
    }
});

app.post('/api/add_deployment', (req, res) => {
    const { name, namespace, replicas, cpu_per_replica, memory_per_replica } = req.body;
    if (!name || !namespace || !replicas || !cpu_per_replica || !memory_per_replica) {
        return res.status(400).json({ success: false, message: "Missing data" });
    }
    const deployment = simulator.addDeployment(name, namespace, parseInt(replicas, 10), parseFloat(cpu_per_replica), parseFloat(memory_per_replica));
    if (deployment) {
        res.json({ success: true, message: `Deployment ${name} created.` });
    } else {
        res.status(400).json({ success: false, message: "Could not create deployment. Check namespace or quota." });
    }
});

app.post('/api/scale_deployment', (req, res) => {
    const { name, new_replica_count } = req.body;
    if (!name || new_replica_count < 0) {
        return res.status(400).json({ success: false, message: "Missing data or invalid replica count" });
    }
    if (simulator.scaleDeployment(name, parseInt(new_replica_count, 10))) {
        res.json({ success: true, message: `Deployment ${name} scaled to ${new_replica_count} replicas.` });
    } else {
        res.status(400).json({ success: false, message: "Could not scale deployment. Check resources." });
    }
});

app.post('/api/delete_deployment', (req, res) => {
    const { name } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: "Missing deployment name" });
    }
    if (simulator.deleteDeployment(name)) {
        res.json({ success: true, message: `Deployment ${name} deleted.` });
    } else {
        res.status(400).json({ success: false, message: "Could not delete deployment." });
    }
});

app.post('/api/set_simulated_workload_factor', (req, res) => {
    const { factor } = req.body;
    if (simulator.setSimulatedWorkloadFactor(parseFloat(factor))) {
        res.json({ success: true, message: `Simulated workload factor set to ${factor * 100}%.` });
    } else {
        res.status(400).json({ success: false, message: "Invalid simulated workload factor. Must be between 0.0 and 1.0." });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
