export class MyMap extends Map {

  /**
   * Find the key of a value in the map
   * 
   * @param {*} valueToFind the value to find in the map
   * @returns the key of a value in the map
   * If there is multiple occurence of the value, return the last index 
   * Return -1 if value is not present
   */
  indexOf(valueToFind) {
    var index = -1;
    this.forEach(function(value, key, map) {
      if (value == valueToFind) {
        index = key;
      }
    });
    return index;
  }
}