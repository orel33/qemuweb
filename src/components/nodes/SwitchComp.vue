<template>
    <div class="switch-component">
        <img class="cog" src="@/assets/cog.png" @click="showParamModal = true"/>
        <img class="run-prompt" src="@/assets/run-icon.jpg" @click="showPrompt"/>
        <img class="switch" src="@/assets/switch.png" alt="Un switch" @dblclick="showParamModal = true"/>
        <span class="switch-name">{{name}}</span>

        <Teleport to="body">
            <modal @updateHostName="updateName" @updatePortsCount="updatePorts" @close="showParamModal = false" 
                    :show="showParamModal" :switchId="id" :name="name" :portsCount="portsCount"
                    :portsSide="portsSide" :refreshPortsDisplay="refreshPortsDisplay">
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
import { MyMap } from '@/js/MyMap';
import { Settings } from '@/js/Settings';
import { Terminal } from '@/js/Terminal';

export default defineComponent({
    components: {
        Modal
    },
    data() {
        return {
            id : null,
            number: -1,
            name: "s",
            portsCount: 4,
            portsSide: new MyMap(),
            showParamModal: false,
            settings: null,
            terminal: new Terminal(),
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
        refreshPortsDisplay() {
            // Display or not ports name according to the general setting
            var checked = this.settings.getOption("display-ports-name") == "true";
            var display = checked ? "block" : "none";
            var inputs = document.querySelectorAll(".drawflow-node.Switch .inputs .input");
            for (let input of inputs) {
                input.style.setProperty('--vardisplay', display);
            }
            this.settings.changeReducedMode();
        },
        showPrompt() {
            var term = document.getElementById("term-" + this.id);
            term.style.display = term.style.display == 'none' ? 'block' : 'none';
        }
    },
    mounted() {
        this.editor; // Need to load editor before call it in $nextTick, don't ask
        this.settings = new Settings();
        this.$nextTick(() => {
            this.id = Number(this.$el.parentElement.parentElement.id.split('-')[1]);
            this.number = this.getNumber()+1;
            this.name = this.name + this.number;
            this.updateNodeData();
            this.refreshPortsDisplay();

            this.terminal.createTerminal(this.id, this.name);

            this.portsSide.set(1, 'left');
            this.portsSide.set(2, 'left');
            this.portsSide.set(3, 'left');
            this.portsSide.set(4, 'left');
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