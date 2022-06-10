<template>
    <div @click="displaySel">
        <img class="cog" src="../../assets/cog.png" @click="showParamModal = true"/>
        <img class="computer" src="../../assets/computer.png" />
        <input class="host-name" type="text" v-model="name">

        <Teleport to="body">
            <modal @updateSelectedDistrib="updateSelected" @updateHostName="updateName" @close="showParamModal = false" 
                    :show="showParamModal" :name="name" :distributions="distributions" :selectedDistrib="selectedDistrib">
            <template #header>
                <h3>Host settings</h3>
            </template>
            </modal>
        </Teleport>
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'
import Modal from '../Modal.vue'

export default defineComponent({
    components: {
        Modal
    },
    data() {
        return {
            id: null,
            name: "bob",
            distributions: [
                {
                    value: 'debian10',
                    label: 'Debian 10'
                },
                {
                    value: 'debian10x',
                    label: 'Debian 10 X11'
                },
                {
                    value: 'debian9',
                    label: 'Debian 9'
                },
                {
                    value: 'tinycore',
                    label: 'Tinycore'
                },
                {
                    value: 'alpine',
                    label: 'Alpine'
                },
                {
                    value: 'alpinex',
                    label: 'Alpine X11'
                },
                {
                    value: 'kali',
                    label: 'Kali'
                },
                {
                    value: 'windowsxp',
                    label: 'Windows XP'
                }
            ],
            showParamModal: false,
            selectedDistrib: "",
            neighboors: [] // Array(neighboorNodeId)
        }
    },
    methods: {
        updateSelected(value) {
            this.selectedDistrib = value;
            console.log(this.selectedDistrib);
        },
        updateName(value) {
            this.name = value;
        }
    },
    mounted() {
        const internalInstance = getCurrentInstance();
        var editor = internalInstance.appContext.app._context.config.globalProperties.$df;
        const neighboors = this.neighboors;
        this.id = editor.nodeId;
        const id = this.id;

        editor.on("connectionCreated", function(info) {
            const inputNode = editor.getNodeFromId(info.input_id);
            const outputNode = editor.getNodeFromId(info.output_id);
            const last = outputNode.outputs[info.output_class].connections.length - 1;
            const connection = outputNode.outputs[info.output_class].connections[last];
            if (inputNode.class == "Host" && outputNode.class == "Host") {
                //Do nothing
            } else if (info.output_id == id) {
                neighboors.push(info.input_id);
                console.log("Host " + id + " added neighboor : ", neighboors);
            } else if (info.input_id == id) {
                neighboors.push(info.output_id);
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
                neighboors.splice(pos, 1);
                console.log("Host " + id + " removed neighboor : ", neighboors);
            } else if (info.input_id == id) {
                const pos = neighboors.indexOf(info.output_id);
                neighboors.splice(pos, 1);
                console.log("Host " + id + " removed neighboor : ", neighboors);
            }
        });
    }
})
</script>

<style scoped>
img.computer {
    width:65px;
    height:65px;
}
img.cog {
    width:25px;
    height:25px;
    position: relative;
    right: 12px;
    top: 3px;
}
img.cog:hover {
    border: 1px;
    cursor: pointer;
}
select {
    position: relative;
    left: -20px;
    opacity: 0.9;
    border-radius: 35px;
}
.host-name {
    background: none;
    color: white;
    border: none;
    font-size: medium;
    text-align: center;
}
</style>
