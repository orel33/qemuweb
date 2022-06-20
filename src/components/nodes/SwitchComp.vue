<template>
    <div class="switch-component">
        <img class="cog" src="../../assets/cog.png" @click="showParamModal = true"/>
        <img class="switch" src="../../assets/switch.png" alt="Un switch" @dblclick="showParamModal = true"/>
        <span class="switch-name">{{name}}</span>

        <Teleport to="body">
            <modal @updateHostName="updateName" @updatePortsCount="updatePorts" @close="showParamModal = false" 
                    :show="showParamModal" :switchId="id" :name="name" :portsCount="portsCount" :refreshPortsName="refreshPortsName">
            <template #header>
                <h2>Switch settings</h2>
            </template>
            </modal>
        </Teleport>
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'
import Modal from '../SwitchModal.vue';

export default defineComponent({
    components: {
        Modal
    },
    data() {
        return {
            id : null,
            number: -1,
            name: "s",
            portsCount: 1,
            showParamModal: false
        }
    },
    computed: {
        editor: {
            get() {
                return getCurrentInstance().appContext.app._context.config.globalProperties.$df;
            }
        },
        displayPorts: {
            get() {
                return document.getElementById("settings").getAttribute("data-display-ports-name");
            }
        }
    },
    methods: {
        getNumber() {
            return this.editor.getNodesFromName('Switch').indexOf(this.id);
        },
        updateName(value) {
            this.name = value;
            this.updateNodeData();
        },
        updatePorts(value) {
            this.portsCount = value;
            this.updateNodeData();
        },
        updateNodeData() {
            this.editor.updateNodeDataFromId(this.id, {"name": this.name, "portsCount": this.portsCount});
        },
        refreshPortsName() {
            var checked = document.getElementById("settings").getAttribute("data-display-ports-name") == "true";
            var display = checked ? "block" : "none";
            var inputs = document.querySelectorAll(".drawflow-node.Switch .inputs .input");
            for (let input of inputs) {
                input.style.setProperty('--vardisplay', display);
            }
        }
    },
    beforeMount() {
        this.id = this.editor.nodeId;
    },
    mounted() {
        this.$nextTick(() => {
            this.number = this.getNumber()+1;
            this.name = this.name + this.number;
            this.updateNodeData();
            this.refreshPortsName();
        });
    }
})
</script>

<style scoped>
img.cog {
    width:25px;
    height:25px;
    position: relative;
    top: 3px;
}
span.switch-name {
    display: block;
    font-size: medium;
    text-align: center;
}
</style>