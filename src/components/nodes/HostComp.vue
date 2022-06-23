<template>
    <div>
        <img class="cog" src="../../assets/cog.png" @click="showParamModal = true"/>
        <img class="run-prompt" src="../../assets/run-icon.jpg" @click="showPrompt"/>
        <img class="computer" src="../../assets/computer.png" @dblclick="showParamModal = true"/>
        <span class="host-name">{{name}}</span>

        <div class="terminal-container draggable ui-widget-content" style="display:none"></div>

        <Teleport to="body">
            <modal @updateSystem="updateSystem" @updateHostName="updateName" @updateNeighboors="updateNeighboors" @updateInterfaces="updateInterfaces" 
                    @close="showParamModal = false" 
                    :show="showParamModal" :hostId="id" :name="name" :distributions="distributions" :system="system" 
                    :neighboors="neighboors" :interfacesCount="interfacesCount" :interfacesSide="interfacesSide"
                    :refreshInterfacesName="refreshInterfacesName">
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
import { MyMap } from "@/MyMap"; 
import { Settings } from '@/Settings';
import { TerminalSetup } from '@/TerminalSetup';
//
import { TerminalUI } from '@/TerminalUI';
//

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
            terminalSetup: null,
            distributions: [
                {
                    value: 'debian10',
                    label: 'Debian 10',
                    img: require("../../assets/debian.png")
                },
                {
                    value: 'debian10x',
                    label: 'Debian 10 X11',
                    img: require("../../assets/debian.png")
                },
                {
                    value: 'debian9',
                    label: 'Debian 9',
                    img: require("../../assets/debian.png")
                },
                {
                    value: 'tinycore',
                    label: 'Tinycore',
                    img: require("../../assets/tinycore.png")
                },
                {
                    value: 'alpine',
                    label: 'Alpine',
                    img: require("../../assets/alpine.png")
                },
                {
                    value: 'alpinex',
                    label: 'Alpine X11',
                    img: require("../../assets/alpine.png")
                },
                {
                    value: 'kali',
                    label: 'Kali',
                    img: require("../../assets/kali.jpg")
                },
                {
                    value: 'windowsxp',
                    label: 'Windows XP',
                    img: require("../../assets/windows.png")
                }
            ],
            showParamModal: false
        }
    },
    computed: {
        editor: {
            get() {
                return getCurrentInstance().appContext.app._context.config.globalProperties.$df;
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
            this.editor.updateNodeDataFromId(this.id, {"name": this.name, 
                                                        "interfacesCount": this.interfacesCount,
                                                        "system": this.system,
                                                        "neighboors": Object.fromEntries(this.neighboors)});
        },
        refreshInterfacesName() {
            var checked = this.settings.getOption("display-interfaces-name") == "true";
            var display = checked ? "block" : "none";
            var outputs = document.querySelectorAll(".drawflow-node.Host .outputs .output");
            for (let output of outputs) {
                output.style.setProperty('--vardisplay', display);
            }
        },
        showPrompt() {
            var term = document.getElementById("term-" + this.id);
            term.style.display = term.style.display == 'none' ? 'block' : 'none';
        }
    },
    beforeMount() {
        // beforeMount to avoid to load Modal component (which need this.id) before this code is executed
        const comp = this;
        this.id = this.editor.nodeId;
        const id = this.id;

        this.editor.on("connectionCreated", function(info) {
            if (info.output_id == id) {
                var inter = Number(info.output_class.slice(-1));
                const nodeInfo = comp.editor.getNodeFromId(info.output_id);
                if (nodeInfo.outputs[info.output_class].connections.length > 1) {
                    const removeConnectionInfo = nodeInfo.outputs[info.output_class].connections[0];
                    comp.editor.removeSingleConnection(info.output_id, removeConnectionInfo.node, info.output_class, removeConnectionInfo.output);
                }
                comp.neighboors.set(inter, info.input_id + ":" + info.input_class.slice(-1));
                comp.updateNodeData();
                console.log("Host " + id + " added neighboor : ", comp.neighboors);
            }
        });

        this.editor.on("connectionRemoved", function(info) {
            if (info.output_id == id) {
                comp.neighboors.delete(Number(info.output_class.slice(-1)));
                comp.updateNodeData();
                console.log("Host " + id + " removed neighboor : ", comp.neighboors);
            }
        });
    },
    mounted() {
        this.$nextTick(() => {
            //this.terminalSetup = new TerminalSetup();
            //
            var containers = document.getElementsByClassName("terminal-container");
            var container = containers[containers.length-1];
            container.setAttribute("id", "term-" + this.id);
            var term = new TerminalUI(null);
            term.attachTo(container);
            //
            //this.terminalSetup.start();
            this.number = this.getNumber()+1;
            this.name = this.name + this.number;
            this.updateNodeData();
            this.refreshInterfacesName();

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
