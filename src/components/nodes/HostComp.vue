<template>
    <div>
        <img src="../../assets/computer.png" />
        <input class="host-name" type="text" v-model="name">
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'

export default defineComponent({
    data() {
        return {
            name: "bob"
        }
    }
})
</script>

<style scoped>
img {
    width:65px;
    height:65px;
}
</style>
