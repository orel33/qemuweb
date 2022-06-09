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
            selectedDistrib: ""
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
