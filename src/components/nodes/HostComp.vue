<template>
    <div>
        <img class="cog" src="@/assets/cog.png" @click="showParamModal = true"/>
        <img class="run-prompt" src="@/assets/run-icon.jpg" @click="showPrompt"/>
        <!--<img class="cable" src="@/assets/cable.png" @click="pullCable" style="display:none"/>-->

        <img class="computer" src="@/assets/computer.png" @dblclick="showParamModal = true"/>
        <span class="host-name">{{name}}</span>

        <Teleport to="body">
            <modal @updateSystem="updateSystem" @updateHostName="updateName" @updateNeighboors="updateNeighboors" @updateInterfaces="updateInterfaces" 
                    @close="showParamModal = false" 
                    :show="showParamModal" :hostId="id" :name="name" :distributions="distributions" :system="system" 
                    :neighboors="neighboors" :interfacesCount="interfacesCount" :interfacesSide="interfacesSide"
                    :refreshInterfacesDisplay="refreshInterfacesDisplay">
            <template #header>
                <h2>Host settings</h2>
            </template>
            </modal>
        </Teleport>
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue';
import Modal from '../HostModal.vue';
import $ from 'jquery';
import jquery_ui from '@/jquery-ui/jquery-ui.js';
import { Terminal } from '@/js/Terminal';
import { MyMap } from "@/js/MyMap"; 
import { Settings } from '@/js/Settings';

export default defineComponent({
    components: {
        Modal
    },
    data() {
        return {
            id: null,
            name: "host",
            number: -1,
            system: "debian10",
            neighboors: new MyMap(), // Map<interfaceNumber, neighboorNodeId:portNumber>,
            interfacesCount: 1,
            interfacesSide: new MyMap(), // Map<interfaceNumber, side>
            settings: new Settings(),
            terminal: null,
            showParamModal: false
        }
    },
    computed: {
        editor: {
            get() {
                return getCurrentInstance().appContext.app._context.config.globalProperties.$df;
            }
        },
        isReducedMode: {
            get() {
                return this.settings.getOptionBool('reduced-mode');
            }
        },
        distributions: {
            get() {
                if (document.getElementById("distributions-storage").innerHTML.length == 0) {
                    return {"systemsListLoadFailed": ""}
                }
                return JSON.parse(document.getElementById("distributions-storage").innerHTML).images;
            }
        },
        imageDir: {
            get() {
                return JSON.parse(document.getElementById("distributions-storage").innerHTML).imagesdir;
            }
        }
    },
    methods: {
        getNumber() {
            return this.editor.getNodesFromName('Host').indexOf(this.id);
        },
        updateSystem(value) {
            this.system = value;
            this.updateNodeData();
        },
        updateName(value) {
            this.name = value;
            this.updateNodeData();
        },
        updateNeighboors(value) {
            this.neighboors = value;
            this.updateNodeData();
        },
        updateInterfaces(value) {
            this.interfacesCount = value;
            this.updateNodeData();
        },
        updateNodeData() {
            this.editor.updateNodeDataFromId(this.id, { "name": this.name, 
                                                        "interfacesCount": this.interfacesCount,
                                                        "system": this.system,
                                                        "neighboors": Object.fromEntries(this.neighboors)});
        },
        refreshInterfacesDisplay() {
            var checked = this.settings.getOption("display-interfaces-name") == "true";
            var display = checked ? "block" : "none";
            var outputs = document.querySelectorAll(".drawflow-node.Host .outputs .output");
            for (let output of outputs) {
                output.style.setProperty('--vardisplay', display);
            }
            this.settings.changeReducedMode();
        },
        showPrompt() {
            var term = document.getElementById("term-" + this.id);
            term.querySelector("span.term-name").innerHTML = this.name;
            term.style.display = term.style.display == 'none' ? 'block' : 'none';

            if (!this.terminal.connected) {
                this.terminal.startConnection();
            }
        }
    },
    mounted() {
        this.editor; // Need to call editor before call it in $nextTick, don't ask
        this.settings = new Settings();
        this.$nextTick(() => {
            //nextTick runs in a context where Drawflow has already created the component
            this.id = Number(this.$el.parentElement.parentElement.id.split('-')[1]);
            this.terminal = new Terminal(this.id, "host");
            const comp = this;
            this.editor.on("connectionCreated", function(info) {
                if (info.output_id == comp.id) {
                    var inter = Number(info.output_class.slice(-1));
                    const nodeInfo = comp.editor.getNodeFromId(info.output_id);
                    if (nodeInfo.outputs[info.output_class].connections.length > 1) {
                        const removeConnectionInfo = nodeInfo.outputs[info.output_class].connections[0];
                        comp.editor.removeSingleConnection(info.output_id, removeConnectionInfo.node, info.output_class, removeConnectionInfo.output);
                    }
                    comp.neighboors.set(inter, info.input_id + ":" + info.input_class.slice(-1));
                    comp.updateNodeData();
                    console.log("Host " + comp.id + " added neighboor : ", comp.neighboors);
                }
            });

            this.editor.on("connectionRemoved", function(info) {
                if (info.output_id == comp.id) {
                    comp.neighboors.delete(Number(info.output_class.slice(-1)));
                    comp.updateNodeData();
                    console.log("Host " + comp.id + " removed neighboor : ", comp.neighboors);
                }
            });
            this.number = this.getNumber() + 1;
            const dataName = this.editor.getNodeFromId(this.id).data.name;
            this.name = dataName == undefined ? this.name + this.number : dataName;
            const dataSystem = this.editor.getNodeFromId(this.id).data.system;
            this.system = dataSystem == undefined ? this.system : dataSystem;
            this.updateNodeData();
            this.refreshInterfacesDisplay();

            this.terminal.createTerminal(this.id, this.name);

            this.interfacesSide.set(1, 'right');
        });
    }
})
</script>

<style scoped>
img.cog {
    width:25px;
    height:25px;
    position: relative;
    right: 12px;
    top: 3px;
}
select {
    position: relative;
    left: -20px;
    opacity: 0.9;
    border-radius: 35px;
}
span.host-name {
    display: block;
    font-size: medium;
    text-align: center;
}
</style>
