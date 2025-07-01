const RESERVED_CPU = 2.0;
const RESERVED_MEMORY = 4.0;

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
        if (index > -1) this.pods.splice(index, 1);
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
            cpu_utilization_percent: this.allocatableCpu > 0 ? (this.cpuAllocated / this.allocatableCpu) * 100 : 0,
            memory_utilization_percent: this.allocatableMemory > 0 ? (this.memoryAllocated / this.allocatableMemory) * 100 : 0,
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

    allocateResources(cpu, memory) {
        if ((this.cpuAllocated + cpu) <= this.cpuQuota && (this.memoryAllocated + memory) <= this.memoryQuota) {
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
            this.pods.push(new Pod(`${this.name}-${i}`, this.cpuRequestPerReplica, this.memoryRequestPerReplica));
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
        if (!name) name = `worker-node-${this.nodeCounter}`;
        const node = new WorkerNode(name, cpu, memory);
        this.workerNodes.push(node);
        return node;
    }

    setTotalWorkerNodes(targetCount) {
        const currentCount = this.workerNodes.length;
        if (targetCount < currentCount) {
            this.workerNodes.splice(targetCount);
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
        this.workerNodes.forEach(node => {
            node.cpuAllocated = 0;
            node.memoryAllocated = 0;
            node.pods = [];
        });
        this.deployments.forEach(dep => {
            dep.pods.forEach(pod => {
                pod.status = "Pending";
                pod.node = null;
            });
        });
        this.deployments.forEach(dep => this.allocateDeploymentPods(dep));
    }

    createNamespace(name, cpuQuota, memoryQuota) {
        if (this.namespaces[name]) return null;
        const namespace = new Namespace(name, cpuQuota, memoryQuota);
        this.namespaces[name] = namespace;
        return namespace;
    }

    addDeployment(name, namespaceName, replicaCount, cpuRequestPerReplica, memoryRequestPerReplica) {
        const namespace = this.namespaces[namespaceName];
        if (!namespace) return null;
        const totalCpuNeeded = replicaCount * cpuRequestPerReplica;
        const totalMemoryNeeded = replicaCount * memoryRequestPerReplica;
        if (!namespace.allocateResources(totalCpuNeeded, totalMemoryNeeded)) return null;
        const deployment = new Deployment(name, namespace, replicaCount, cpuRequestPerReplica, memoryRequestPerReplica);
        this.deployments.push(deployment);
        namespace.deployments.push(deployment);
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
            namespace.allocateResources(oldTotalCpu, oldTotalMemory);
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
        const nsIndex = namespace.deployments.indexOf(deployment);
        if (nsIndex > -1) namespace.deployments.splice(nsIndex, 1);
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
        this.workerNodes.forEach(node => {
            node.cpuAllocated = 0;
            node.memoryAllocated = 0;
            node.pods = [];
        });
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
                this.createNamespace(nsName, avgCpuPerNs * 1.2, avgMemoryPerNs * 1.2);
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