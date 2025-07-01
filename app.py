from flask import Flask, render_template, request, jsonify
import random
import math

app = Flask(__name__)

# --- Simulation Classes (from previous CLI version, adapted for web) ---

RESERVED_CPU = 2.0 # Cores reserved for system and OpenShift components
RESERVED_MEMORY = 4.0 # GB reserved for system and OpenShift components

class WorkerNode:
    def __init__(self, name, cpu_capacity, memory_capacity):
        self.name = name
        self.cpu_capacity = cpu_capacity
        self.memory_capacity = memory_capacity
        self.cpu_allocated = 0
        self.memory_allocated = 0
        self.pods = []

    @property
    def allocatable_cpu(self):
        return max(0, self.cpu_capacity - RESERVED_CPU)

    @property
    def allocatable_memory(self):
        return max(0, self.memory_capacity - RESERVED_MEMORY)

    @property
    def cpu_available(self):
        return self.cpu_capacity - self.cpu_allocated

    @property
    def memory_available(self):
        return self.memory_capacity - self.memory_allocated

    def allocate_resources(self, cpu, memory):
        if (self.allocatable_cpu - self.cpu_allocated) >= cpu and \
           (self.allocatable_memory - self.memory_allocated) >= memory:
            self.cpu_allocated += cpu
            self.memory_allocated += memory
            return True
        return False

    def deallocate_resources(self, cpu, memory):
        self.cpu_allocated -= cpu
        self.memory_allocated -= memory
        if self.cpu_allocated < 0:
            self.cpu_allocated = 0
        if self.memory_allocated < 0:
            self.memory_allocated = 0

    def add_pod(self, pod):
        self.pods.append(pod)

    def remove_pod(self, pod):
        self.pods.remove(pod)

    def get_utilization_percentage(self, current, total):
        return (current / total) * 100 if total > 0 else 0

    def to_dict(self):
        return {
            "name": self.name,
            "cpu_capacity": self.cpu_capacity,
            "memory_capacity": self.memory_capacity,
            "allocatable_cpu": self.allocatable_cpu,
            "allocatable_memory": self.allocatable_memory,
            "cpu_allocated": self.cpu_allocated,
            "memory_allocated": self.memory_allocated,
            "cpu_utilization_percent": self.get_utilization_percentage(self.cpu_allocated, self.allocatable_cpu),
            "memory_utilization_percent": self.get_utilization_percentage(self.memory_allocated, self.allocatable_memory),
            "pods": [pod.to_dict() for pod in self.pods]
        }

class Namespace:
    def __init__(self, name, cpu_quota, memory_quota):
        self.name = name
        self.cpu_quota = cpu_quota
        self.memory_quota = memory_quota
        self.deployments = []
        self.cpu_allocated = 0
        self.memory_allocated = 0

    def add_deployment(self, deployment):
        self.deployments.append(deployment)

    def remove_deployment(self, deployment):
        self.deployments.remove(deployment)

    def allocate_resources(self, cpu, memory):
        if (self.cpu_allocated + cpu) <= self.cpu_quota and \
           (self.memory_allocated + memory) <= self.memory_quota:
            self.cpu_allocated += cpu
            self.memory_allocated += memory
            return True
        return False

    def deallocate_resources(self, cpu, memory):
        self.cpu_allocated -= cpu
        self.memory_allocated -= memory
        if self.cpu_allocated < 0: self.cpu_allocated = 0
        if self.memory_allocated < 0: self.memory_allocated = 0

    def to_dict(self):
        return {
            "name": self.name,
            "cpu_quota": self.cpu_quota,
            "memory_quota": self.memory_quota,
            "cpu_allocated": self.cpu_allocated,
            "memory_allocated": self.memory_allocated,
            "deployment_count": len(self.deployments)
        }

class Pod: # Internal representation of a single pod instance
    def __init__(self, name, cpu_request, memory_request):
        self.name = name
        self.cpu_request = cpu_request
        self.memory_request = memory_request
        self.status = "Pending"
        self.node = None # Reference to the WorkerNode object

    def to_dict(self):
        return {
            "name": self.name,
            "cpu_request": self.cpu_request,
            "memory_request": self.memory_request,
            "status": self.status,
            "node": self.node.name if self.node else "N/A"
        }

class Deployment:
    def __init__(self, name, namespace, replica_count, cpu_request_per_replica, memory_request_per_replica):
        self.name = name
        self.namespace = namespace # Reference to Namespace object
        self.replica_count = replica_count
        self.cpu_request_per_replica = cpu_request_per_replica
        self.memory_request_per_replica = memory_request_per_replica
        self.pods = [] # List of Pod objects

        self.create_pods()

    def create_pods(self):
        for i in range(self.replica_count):
            pod_name = f"{self.name}-{i}"
            self.pods.append(Pod(pod_name, self.cpu_request_per_replica, self.memory_request_per_replica))

    def to_dict(self):
        return {
            "name": self.name,
            "namespace": self.namespace.name,
            "replica_count": self.replica_count,
            "cpu_request_per_replica": self.cpu_request_per_replica,
            "memory_request_per_replica": self.memory_request_per_replica,
            "total_cpu_request": self.replica_count * self.cpu_request_per_replica,
            "total_memory_request": self.replica_count * self.memory_request_per_replica,
            "running_pods": sum(1 for pod in self.pods if pod.status == "Running"),
            "pods": [pod.to_dict() for pod in self.pods]
        }




class OpenShiftSimulator:
    def __init__(self):
        self.worker_nodes = []
        self.namespaces = {}
        self.deployments = []
        self.simulated_workload_factor = 0.0 # 0.0 means no simulated workload
        self.node_counter = 0 # Initialize to 0, will be incremented for first node

        # Add initial default worker nodes
        for _ in range(3):
            self.add_worker_node(cpu=128.0, memory=1500.0)

    def add_worker_node(self, name=None, cpu=128.0, memory=1500.0):
        self.node_counter += 1
        if name is None:
            name = f"worker-node-{self.node_counter}"
        node = WorkerNode(name, cpu, memory)
        self.worker_nodes.append(node)
        return node

    

    def set_total_worker_nodes(self, target_count):
        current_count = len(self.worker_nodes)
        if target_count < current_count:
            # Remove nodes and deallocate their pods
            nodes_to_remove = self.worker_nodes[target_count:]
            self.worker_nodes = self.worker_nodes[:target_count]

            # Deallocate pods from removed nodes and collect them for re-allocation
            pods_to_reallocate = []
            for node in nodes_to_remove:
                for pod in node.pods:
                    pod.node = None
                    pod.status = "Pending"
                    pods_to_reallocate.append(pod)
                node.pods = [] # Clear pods from the removed node
                node.cpu_allocated = 0
                node.memory_allocated = 0
            
            # Re-attempt allocation for deallocated pods
            # We need to iterate through deployments to find the parent of each pod
            for pod in pods_to_reallocate:
                for dep in self.deployments:
                    if pod in dep.pods:
                        self.allocate_deployment_pods(dep) # Re-allocate pods of this deployment
                        break

        elif target_count > current_count:
            # Add new nodes
            for _ in range(target_count - current_count):
                self.add_worker_node()
            
            # Re-allocate all existing pods to spread them across new nodes
            all_current_pods = []
            for dep in self.deployments:
                for pod in dep.pods:
                    if pod.status == "Running": # Only deallocate running pods
                        if pod.node:
                            pod.node.deallocate_resources(pod.cpu_request, pod.memory_request)
                            pod.node.remove_pod(pod)
                        pod.node = None
                        pod.status = "Pending"
                    all_current_pods.append(pod)
            
            # Re-allocate all pods
            for pod in all_current_pods:
                for dep in self.deployments:
                    if pod in dep.pods:
                        self.allocate_deployment_pods(dep) # Re-allocate pods of this deployment
                        break

        return True

    def create_namespace(self, name, cpu_quota, memory_quota):
        if name in self.namespaces:
            return None # Already exists
        namespace = Namespace(name, cpu_quota, memory_quota)
        self.namespaces[name] = namespace
        return namespace

    def add_deployment(self, name, namespace_name, replica_count, cpu_request_per_replica, memory_request_per_replica):
        if namespace_name not in self.namespaces:
            return None # Namespace does not exist

        namespace = self.namespaces[namespace_name]
        total_cpu_needed = replica_count * cpu_request_per_replica
        total_memory_needed = replica_count * memory_request_per_replica

        if not namespace.allocate_resources(total_cpu_needed, total_memory_needed):
            return None # Namespace quota exceeded

        deployment = Deployment(name, namespace, replica_count, cpu_request_per_replica, memory_request_per_replica)
        self.deployments.append(deployment)
        namespace.add_deployment(deployment)
        self.allocate_deployment_pods(deployment)
        return deployment

    def scale_deployment(self, name, new_replica_count):
        deployment = next((dep for dep in self.deployments if dep.name == name), None)
        if not deployment:
            return False # Deployment not found

        namespace = deployment.namespace
        old_total_cpu = deployment.replica_count * deployment.cpu_request_per_replica
        old_total_memory = deployment.replica_count * deployment.memory_request_per_replica

        new_total_cpu = new_replica_count * deployment.cpu_request_per_replica
        new_total_memory = new_replica_count * deployment.memory_request_per_replica

        cpu_diff = new_total_cpu - old_total_cpu
        memory_diff = new_total_memory - old_total_memory

        # Deallocate old resources from namespace and nodes
        namespace.deallocate_resources(old_total_cpu, old_total_memory)
        for pod in deployment.pods:
            if pod.node:
                pod.node.deallocate_resources(pod.cpu_request, pod.memory_request)
                pod.node.remove_pod(pod)
        
        # Update replica count and re-create pods
        deployment.replica_count = new_replica_count
        deployment.pods = []
        deployment.create_pods()

        # Attempt to allocate new resources to namespace and nodes
        if not namespace.allocate_resources(new_total_cpu, new_total_memory):
            # If new allocation fails, revert to old state (simplified: just don't allocate new pods)
            print(f"Failed to scale deployment {name}: Namespace quota exceeded.")
            return False

        self.allocate_deployment_pods(deployment)
        return True

    def delete_deployment(self, name):
        deployment = next((dep for dep in self.deployments if dep.name == name), None)
        if not deployment:
            return False # Deployment not found

        # Deallocate resources from namespace
        namespace = deployment.namespace
        total_cpu = deployment.replica_count * deployment.cpu_request_per_replica
        total_memory = deployment.replica_count * deployment.memory_request_per_replica
        namespace.deallocate_resources(total_cpu, total_memory)
        namespace.remove_deployment(deployment)

        # Deallocate resources from nodes
        for pod in deployment.pods:
            if pod.node:
                pod.node.deallocate_resources(pod.cpu_request, pod.memory_request)
                pod.node.remove_pod(pod)
        
        self.deployments.remove(deployment)
        return True

    def allocate_deployment_pods(self, deployment):
        # Sort nodes by current CPU utilization to try and balance load
        sorted_nodes = sorted(self.worker_nodes, key=lambda node: node.cpu_allocated)

        for pod in deployment.pods:
            if pod.status == "Pending": # Only try to allocate pending pods
                allocated = False
                for node in sorted_nodes:
                    if node.allocate_resources(pod.cpu_request, pod.memory_request):
                        pod.status = "Running"
                        pod.node = node
                        node.add_pod(pod)
                        allocated = True
                        break
                if not allocated:
                    # Pod remains pending if no node can accommodate
                    pass

    def set_simulated_workload_factor(self, factor):
        if not (0.0 <= factor <= 1.0):
            return False
        self.simulated_workload_factor = factor

        # Clear existing namespaces and deployments for new simulation
        for dep in self.deployments:
            for pod in dep.pods:
                if pod.node:
                    pod.node.deallocate_resources(pod.cpu_request, pod.memory_request)
                    pod.node.remove_pod(pod)
        self.namespaces = {}
        self.deployments = []

        if factor > 0:
            total_allocatable_cpu = sum(node.allocatable_cpu for node in self.worker_nodes)
            total_allocatable_memory = sum(node.allocatable_memory for node in self.worker_nodes)

            # Determine number of namespaces and deployments based on factor
            # Scale dynamically without hard limits
            # Limit number of namespaces and deployments to 10
            num_namespaces_to_create = max(1, min(10, math.ceil(factor * 10))) # Max 10 namespaces
            num_deployments_per_namespace_target = max(1, min(10, math.ceil(factor * 10))) # Max 10 deployments per namespace

            # Calculate average resources per namespace
            avg_cpu_per_ns = total_allocatable_cpu / num_namespaces_to_create
            avg_memory_per_ns = total_allocatable_memory / num_namespaces_to_create

            for i in range(num_namespaces_to_create):
                ns_name = f"sim-ns-{i}"
                # Give each namespace a quota that scales with its share of the total, plus a buffer
                ns_cpu_quota = avg_cpu_per_ns * 1.2 # 20% buffer
                ns_memory_quota = avg_memory_per_ns * 1.2 # 20% buffer
                self.create_namespace(ns_name, ns_cpu_quota, ns_memory_quota)

                # Distribute deployments within this namespace
                current_ns = self.namespaces[ns_name]
                num_deployments_for_this_ns = num_deployments_per_namespace_target # Simple for now

                if num_deployments_for_this_ns > 0:
                    # Calculate total resources to be requested by deployments in this namespace
                    # This should be proportional to the overall factor and this namespace's share
                    target_cpu_for_ns_deployments = (total_allocatable_cpu * factor) / num_namespaces_to_create
                    target_memory_for_ns_deployments = (total_allocatable_memory * factor) / num_namespaces_to_create

                    cpu_per_deployment = target_cpu_for_ns_deployments / num_deployments_for_this_ns
                    memory_per_deployment = target_memory_for_ns_deployments / num_deployments_for_this_ns

                    for j in range(num_deployments_for_this_ns):
                        dep_name = f"sim-dep-{i}-{j}"
                        replica_count = random.randint(1, 3) # Keep replica count small

                        cpu_per_replica = max(0.01, cpu_per_deployment / replica_count)
                        memory_per_replica = max(0.01, memory_per_deployment / replica_count)

                        self.add_deployment(dep_name, ns_name, replica_count, cpu_per_replica, memory_per_replica)

        return True

    def get_cluster_summary(self):
        total_cpu_capacity = sum(node.cpu_capacity for node in self.worker_nodes)
        total_memory_capacity = sum(node.memory_capacity for node in self.worker_nodes)
        total_allocatable_cpu = sum(node.allocatable_cpu for node in self.worker_nodes)
        total_allocatable_memory = sum(node.allocatable_memory for node in self.worker_nodes)
        total_cpu_allocated = sum(node.cpu_allocated for node in self.worker_nodes)
        total_memory_allocated = sum(node.memory_allocated for node in self.worker_nodes)

        return {
            "total_nodes": len(self.worker_nodes),
            "total_cpu_capacity": total_cpu_capacity,
            "total_memory_capacity": total_memory_capacity,
            "total_allocatable_cpu": total_allocatable_cpu,
            "total_allocatable_memory": total_allocatable_memory,
            "total_reserved_cpu": len(self.worker_nodes) * RESERVED_CPU,
            "total_reserved_memory": len(self.worker_nodes) * RESERVED_MEMORY,
            "total_cpu_allocated": total_cpu_allocated,
            "total_memory_allocated": total_memory_allocated,
            "total_cpu_available": total_allocatable_cpu - total_cpu_allocated,
            "total_memory_available": total_allocatable_memory - total_memory_allocated,
            "simulated_workload_factor": self.simulated_workload_factor
        }

# --- Flask Application Setup ---

simulator = OpenShiftSimulator()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def get_status():
    nodes_data = [node.to_dict() for node in simulator.worker_nodes]
    namespaces_data = [ns.to_dict() for ns in simulator.namespaces.values()]
    deployments_data = [dep.to_dict() for dep in simulator.deployments]
    cluster_summary = simulator.get_cluster_summary()

    return jsonify({
        "nodes": nodes_data,
        "namespaces": namespaces_data,
        "deployments": deployments_data,
        "cluster_summary": cluster_summary,
        "simulated_workload_factor": simulator.simulated_workload_factor
    })

@app.route('/api/set_node_count', methods=['POST'])
def set_node_count():
    data = request.json
    count = int(data.get('count'))

    if simulator.set_total_worker_nodes(count):
        return jsonify({"success": True, "message": f"Node count set to {count}."})
    else:
        return jsonify({"success": False, "message": "Could not set node count."}), 400

@app.route('/api/create_namespace', methods=['POST'])
def create_namespace():
    data = request.json
    name = data.get('name')
    cpu_quota = float(data.get('cpu_quota'))
    memory_quota = float(data.get('memory_quota'))

    if not name or not cpu_quota or not memory_quota:
        return jsonify({"success": False, "message": "Missing data"}), 400

    if simulator.create_namespace(name, cpu_quota, memory_quota):
        return jsonify({"success": True, "message": f"Namespace {name} created with CPU: {cpu_quota} and Memory: {memory_quota}."})
    else:
        return jsonify({"success": False, "message": f"Namespace {name} already exists."}), 409

@app.route('/api/add_deployment', methods=['POST'])
def add_deployment():
    data = request.json
    name = data.get('name')
    namespace = data.get('namespace')
    replicas = int(data.get('replicas'))
    cpu_per_replica = float(data.get('cpu_per_replica'))
    memory_per_replica = float(data.get('memory_per_replica'))

    if not name or not namespace or not replicas or not cpu_per_replica or not memory_per_replica:
        return jsonify({"success": False, "message": "Missing data"}), 400

    deployment = simulator.add_deployment(name, namespace, replicas, cpu_per_replica, memory_per_replica)
    if deployment:
        return jsonify({"success": True, "message": f"Deployment {name} created with {replicas} replicas."})
    else:
        return jsonify({"success": False, "message": f"Could not create deployment {name}. Check namespace or quota."}), 400

@app.route('/api/scale_deployment', methods=['POST'])
def scale_deployment():
    data = request.json
    name = data.get('name')
    new_replica_count = int(data.get('new_replica_count'))

    if not name or new_replica_count < 0:
        return jsonify({"success": False, "message": "Missing data or invalid replica count"}), 400

    if simulator.scale_deployment(name, new_replica_count):
        return jsonify({"success": True, "message": f"Deployment {name} scaled to {new_replica_count} replicas."})
    else:
        return jsonify({"success": False, "message": f"Could not scale deployment {name}. Check resources."}), 400

@app.route('/api/delete_deployment', methods=['POST'])
def delete_deployment():
    data = request.json
    name = data.get('name')

    if not name:
        return jsonify({"success": False, "message": "Missing deployment name"}), 400

    if simulator.delete_deployment(name):
        return jsonify({"success": True, "message": f"Deployment {name} deleted."})
    else:
        return jsonify({"success": False, "message": f"Could not delete deployment {name}."}), 400

@app.route('/api/set_simulated_workload_factor', methods=['POST'])
def set_simulated_workload_factor():
    data = request.json
    factor = float(data.get('factor'))

    if simulator.set_simulated_workload_factor(factor):
        return jsonify({"success": True, "message": f"Simulated workload factor set to {factor*100:.1f}%."})
    else:
        return jsonify({"success": False, "message": "Invalid simulated workload factor. Must be between 0.0 and 1.0."}), 400

if __name__ == '__main__':
    app.run(debug=True)
