<template>
    <div>
        <img class="cog" src="../../assets/cog.png" @click="showParamModal = true"/>
        <img class="computer" src="../../assets/computer.png" />
        <span class="host-name">{{name}}</span>

        <Teleport to="body">
            <modal @updateSelectedDistrib="updateSelected" @updateHostName="updateName" @updateNeighboors="updateNeighboors" @updateInterfaces="updateInterfaces" 
                    @close="showParamModal = false" 
                    :show="showParamModal" :hostId="id" :name="name" :distributions="distributions" :selectedDistrib="selectedDistrib" :neighboors="neighboors"
                    :interfacesCount="interfacesCount">
            <template #header>
                <h2>Host settings</h2>
            </template>
            </modal>
        </Teleport>
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue';
import Modal from '../ModalHost.vue';
import { MyMap } from "../../MyMap"; 

export default defineComponent({
    components: {
        Modal
    },
    data() {
        return {
            id: null,
            name: "bob",
            selectedDistrib: "debian10",
            neighboors: new MyMap(), // Map<interfaceNumber, neighboorNodeId>,
            interfacesCount: 1,
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
        updateSelected(value) {
            this.selectedDistrib = value;
            console.log(this.selectedDistrib);
        },
        updateName(value) {
            this.name = value;
            this.editor.updateNodeDataFromId(this.id, {"name": this.name});
        },
        updateNeighboors(value) {
            this.neighboors = value;
        },
        updateInterfaces(value) {
            this.interfacesCount = value;
        }
    },
    beforeMount() {
        // beforeMount to avoid to load Modal component (which need this.id) before this code is executed
        const neighboors = this.neighboors;
        const editor = this.editor;
        this.id = this.editor.nodeId;
        const id = this.id;

        editor.on("connectionCreated", function(info) {
            const inputNode = editor.getNodeFromId(info.input_id);
            const outputNode = editor.getNodeFromId(info.output_id);
            const last = outputNode.outputs[info.output_class].connections.length - 1;
            const connection = outputNode.outputs[info.output_class].connections[last];
            if (inputNode.class == "Host" && outputNode.class == "Host") {
                //Do nothing
            } else if (info.output_id == id) {
                neighboors.set(neighboors.size, info.input_id);
                console.log("Host " + id + " added neighboor : ", neighboors);
            } else if (info.input_id == id) {
                neighboors.set(neighboors.size, info.output_id);
                console.log("Host " + id + " added neighboor : ", neighboors);
            }
        });

        editor.on("connectionRemoved", function(info) {
            const inputNode = editor.getNodeFromId(info.input_id);
            const outputNode = editor.getNodeFromId(info.output_id);
            const last = outputNode.outputs[info.output_class].connections.length - 1;
            const connection = outputNode.outputs[info.output_class].connections[last];

            if (inputNode.class == "Host" && outputNode.class == "Host") {
                //Do nothing
            } else if (info.output_id == id) {
                const pos = neighboors.indexOf(info.input_id);
                neighboors.delete(pos);
                console.log("Host " + id + " removed neighboor : ", neighboors);
            } else if (info.input_id == id) {
                const pos = neighboors.indexOf(info.output_id);
                neighboors.delete(pos);
                console.log("Host " + id + " removed neighboor : ", neighboors);
            }
        });
    },
    mounted() {
        this.$nextTick(() => {
            //this.number = this.getNumber()+1;
            //this.name = this.name + this.number;
            this.editor.updateNodeDataFromId(this.id, {"name": this.name});
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
