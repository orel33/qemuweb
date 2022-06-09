<template>
    <div>
        <select>
            <option v-for="item in distributions" :key="item.value" :label="item.label" :value="item.value"></option>
        </select>
        <img src="../../assets/computer.png" />
        <input class="host-name" type="text" v-model="name">
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'

export default defineComponent({
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
            ]
        }
    },
    methods: {
        updateSelect(value) {
            
        }
    }
})
</script>

<style scoped>
img {
    width:65px;
    height:65px;
}
select {
    position: relative;
    left: -20px;
    opacity: 0.9;
    border-radius: 35px;
}
</style>
