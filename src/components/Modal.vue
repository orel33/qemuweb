<script>
export default {
  props: {
    show: Boolean,
    hostId: Number,
    name: String,
    distributions: Array,
    selectedDistrib: String,
    neighboors : Array
  },
  computed: {
    localSelectedDistrib: {
      get() {
        return this.selectedDistrib;
      },
      set(value) {
        this.$emit('updateSelectedDistrib', value)
      }
    },
    localName: {
      get() {
        return this.name;
      },
      set(value) {
        this.$emit('updateHostName', value)
      }
    },
    localNeighboors: {
      get() {
        return this.neighboors;
      },
      set(value) {
        this.$emit('updateNeighboors', value)
      }
    }
  },
  methods: {
    neighboorsChanged() {
      console.log("neighboors changed");
    },
    interfacesChanged() {

    }
  },
  updated() {
    // Triggered when modal pop up
    var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
    var interfacesSelects = neighboorsDiv.querySelectorAll(".interfaces");
    var hostsSelects = neighboorsDiv.querySelectorAll(".hosts");
    for (let i = 0; i < this.neighboors.length; i++) {
      console.log(i);
      interfacesSelects[i].value = 'eth' + i;
      hostsSelects[i].value = this.neighboors[i];
    }
  }
}
</script>

<template>
  <Transition name="modal">
    <div v-if="show" class="modal-mask">
      <div class="modal-wrapper">
        <div class="modal-container">
          <div class="modal-header">
            <slot name="header">default header</slot>
          </div>

          <div :id="'modal-body-div-' + hostId" class="modal-body">
            <select v-model="localSelectedDistrib">
              <option v-for="item in distributions" :key="item.value" :label="item.label" :value="item.value"></option>
            </select>
            <input class="host-name-in-modal" type="text" v-model="localName">
            <div v-for="neigh in neighboors" :key="neigh">
              <select class="interfaces" @change="interfacesChanged">
                <option v-for="item in neighboors" :key="item" :label="'eth'+neighboors.indexOf(item)" :value="'eth'+neighboors.indexOf(item)"></option>
              </select>
              <select class="hosts" @change="hostsChanged">
                <option v-for="item in neighboors" :key="item" :label="'PC n°' + item" :value="item"></option>
              </select>
            </div>
          </div>

          <div class="modal-footer">
            <slot name="footer">
              <button class="modal-default-button" @click="$emit('close')"> OK </button>
            </slot>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style>
.modal-mask {
  position: fixed;
  z-index: 9998;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: table;
  transition: opacity 0.3s ease;
}

.modal-wrapper {
  display: table-cell;
  vertical-align: middle;
}

.modal-container {
  width: 300px;
  margin: 0px auto;
  padding: 20px 30px;
  background-color: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.33);
  transition: all 0.3s ease;
}

.modal-header h3 {
  margin-top: 0;
  color: #42b983;
}

.modal-body {
  margin: 20px 0;
}

.modal-default-button {
  float: right;
}

.modal-footer {
  padding-bottom: 15px;
}

/*
 * The following styles are auto-applied to elements with
 * transition="modal" when their visibility is toggled
 * by Vue.js.
 *
 * You can easily play with the modal transition by editing
 * these styles.
 */

.modal-enter-from {
  opacity: 0;
}

.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-container,
.modal-leave-to .modal-container {
  -webkit-transform: scale(1.1);
  transform: scale(1.1);
}
</style>