<script>
export default {
  props: {
    show: Boolean,
    hostId: Number,
    name: String,
    distributions: Array,
    selectedDistrib: String,
    neighboors : Map
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
    loadNeighboors() {
      // Load the values of neighboors in selscts
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
      var switchsSelects = neighboorsDiv.querySelectorAll(".switchs");
      for (let i = 0; i < this.neighboors.size; i++) {
        switchsSelects[i].value = this.neighboors.get(i);
      }
    },
    switchSwitches(info) {
      var neighboorsDiv = document.getElementById("modal-body-div-" + this.hostId);
      var switchsSelects = neighboorsDiv.querySelectorAll(".switchs");

      // Exemple start state : One host connected to three switches -> {0 => '2', 1 => '3', 2 => '4'}
      // Exemple action : for eth2, we select switch n°2 instead of switch n°4
      // Exemple result : eth2 get switch n°2 and eth0 have to get switch n°4
      var changedInterfaceNum = info[0]; // = 2, key
      var oldSwitchNum = this.neighboors.get(changedInterfaceNum); // = 4, value
      var newSwitchNum = switchsSelects[changedInterfaceNum].value; // = 2, value
      var impactedInterfaceNum = this.neighboors.indexOf(newSwitchNum); // = 0, key

      this.localNeighboors.set(impactedInterfaceNum, oldSwitchNum);
      this.localNeighboors.set(changedInterfaceNum, newSwitchNum);
    },
    switchesChanged(info) {
      this.switchSwitches(info);
      this.loadNeighboors();
    }
  },
  updated() {
    // Triggered when modal pop up
    this.loadNeighboors();
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
            <div class="modal-section">
              <span class="modal-span"> Distribution : </span>
              <select v-model="localSelectedDistrib">
                <option v-for="item in distributions" :key="item.value" :label="item.label" :value="item.value"></option>
              </select>
            </div>
            <div class="modal-section">
              <span class="modal-span"> Nom : </span>
              <input class="host-name-in-modal" type="text" v-model="localName">
            </div>
            <div class="interfaces-div modal-section" v-if="neighboors.size > 0">
              <span class="modal-span"> Changer les interfaces : </span>
              <div class="interfaces-for" v-for="neigh in neighboors" :key="neigh.key">
                <span class="modal-span"> eth{{neigh[0]}} -- </span>
                <select class="switchs" @change="switchesChanged(neigh)">
                  <option v-for="item in neighboors" :key="item[1]" :label="'Switch n°' + item[1]" :value="item[1]"></option>
                </select>
              </div>
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
.modal-section {
  margin-top: 30px;
  color: black;
}

.interfaces-for {
  margin-top: 10px;
}

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
  width: 400px;
  margin: 0px auto;
  padding: 20px 30px;
  background-color: #fff;
  border-radius: 2px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.33);
  transition: all 0.3s ease;
}

.modal-header h2 {
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