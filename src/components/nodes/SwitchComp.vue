<template>
    <div>
        <img src="../../assets/switch.png" alt="Un switch" />
    </div>
</template>

<script>
import { defineComponent, onMounted, getCurrentInstance, readonly, ref, nextTick } from 'vue'

export default defineComponent({
    props: {
        number: {
            type: Number
        }
    },
    mounted() {
        console.log("I'm switch number " + this.number)
    }
})
</script>

<style scoped>
img {
    width:65px;
    height:65px;
}
</style>