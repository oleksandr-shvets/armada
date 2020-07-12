import StateGroupType from "../types/StateGroupType"
import { Entity, Component } from "ecsy"
import StateMap from "../interfaces/StateMap"
import State from "../components/State"
import RingBuffer from "../../common/classes/RingBuffer"

let component: Component<any>
const components = new RingBuffer<Component<any>>(10)
let stateGroupData: StateMap
let stateGroupExists: boolean
// component from state group exists
export const componentsFromStateGroupExist = (entityIn: Entity, stateGroupType: StateGroupType, ignoreComponent?: Component<any>): boolean => {
  stateGroupExists = false
  stateGroupData = entityIn.getComponent(State).data
  stateGroupData.groups[stateGroupType].states.array.forEach(element => {
    if (ignoreComponent && ignoreComponent === element.component) return
    if (entityIn.getComponent(stateGroupData.states[element].component)) stateGroupExists = true
  })
  return stateGroupExists
}

export const removeComponentsFromStateGroup = (entityIn: Entity, stateGroupType: StateGroupType, ignoreComponent?: Component<any>): void => {
  getComponentsFromStateGroup(entityIn, stateGroupType).forEach((component: any) => {
    if (ignoreComponent && ignoreComponent === component) return
    entityIn.removeComponent(component)
  })
  console.log("Removed component")
}

export const getComponentsFromStateGroup = (entityIn: Entity, stateGroupType: StateGroupType): Component<any>[] => {
  components.clear()
  stateGroupData = entityIn.getComponent(State).data
  stateGroupData.groups[stateGroupType].states.array.forEach(element => {
    if (entityIn.getComponent(stateGroupData.states[element].component)) components.add(stateGroupData.states[element].component)
  })
  return components.toArray()
}

export const getComponentFromStateGroup = (entityIn: Entity, stateGroupType: StateGroupType): Component<any> | null => {
  component = null
  stateGroupData = entityIn.getComponent(State).data
  stateGroupData.groups[stateGroupType].states.array.forEach(element => {
    if (entityIn.getComponent(stateGroupData.states[element].component)) component = stateGroupData.states[element].component
  })
  return component
}