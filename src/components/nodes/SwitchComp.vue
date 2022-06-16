<template>
    <div class="switch-component">
        <img class="cog" src="../../assets/cog.png" @click="showParamModal = true"/>
        <img class="switch" src="../../assets/switch.png" alt="Un switch" />
        <span class="switch-name">{{name}}</span>

        <Teleport to="body">
            <modal @updateHostName="updateName" @close="showParamModal = false" :show="showParamModal" :hostId="id" :name="name">
            <template #header>
                <h2>Switch settings</h2>
            </template>
            </modal>
        </Teleport>
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'
import Modal from '../ModalSwitch.vue';

export default defineComponent({
    components: {
        Modal
    },
    data() {
        return {
            id : null,
            number: -1,
            name: "s",
            showParamModal: false,
            nameRequested: false
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
        }
    },
    beforeMount() {
        this.id = this.editor.nodeId;
    },
    mounted() {
        this.$nextTick(() => {
            this.number = this.getNumber()+1;
            this.name = this.name + this.number;
        });
    }
})
</script>

<style scoped>
img.switch {
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
span.switch-name {
    display: block;
    font-size: medium;
    text-align: center;
}
</style>