<template>
    <div class="switch-component">
        <img class="cog" src="../../assets/cog.png" @click="showParamModal = true"/>
        <img class="switch" src="../../assets/switch.png" alt="Un switch" @dblclick="showParamModal = true"/>
        <span class="switch-name">{{name}}</span>

        <Teleport to="body">
            <modal @updateHostName="updateName" @updatePortsCount="updatePorts" @close="showParamModal = false" 
                    :show="showParamModal" :switchId="id" :name="name" :portsCount="portsCount"
                    :portsSide="portsSide" :refreshPortsName="refreshPortsName">
            <template #header>
                <h2>Switch settings</h2>
            </template>
            </modal>
        </Teleport>
    </div>
</template>

<script>
import { MyMap } from '@/MyMap';
import { Settings } from '@/Settings';
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
            portsSide: new MyMap(),
            showParamModal: false,
            settings: null
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
            // Display or not ports name according to the general setting
            var checked = this.settings.getOption("display-ports-name") == "true";
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
        this.settings = new Settings();
        this.$nextTick(() => {
            this.number = this.getNumber()+1;
            this.name = this.name + this.number;
            this.updateNodeData();
            this.refreshPortsName();

            this.portsSide.set(1, 'left');
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