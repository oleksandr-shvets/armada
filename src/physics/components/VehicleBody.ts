import { Component, Types } from "ecsy"

export default class VehicleBody extends Component<any> {}
VehicleBody.schema = {
  mass: { type: Types.Number, default: 1 },
  scale: { type: Types.Number, default: { x: 0.2, y: 0.1, z: 0.1 } },
  wheelMesh: { type: Types.Number, default: 1 },
  convexMesh: { type: Types.Number, default: 0 }
}