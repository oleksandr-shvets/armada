import config from "./serverConfig"
import mediasoup from "mediasoup"
import express from "express"
import https from "https"
import fs from "fs"
import path from "path"
import socketIO from "socket.io"
import MessageTypes from "./MessageTypes"
import dotenv from "dotenv"
import NetworkTransport from "../../interfaces/NetworkTransport"
import MessageQueue from "../../components/MessageQueue"
import Message from "../../interfaces/Message"

const expressApp = express()
dotenv.config()

config.mediasoup.webRtcTransport.listenIps = [{ ip: "127.0.0.1", announcedIp: null }]

let server, io, worker, router, transport

const defaultRoomState = {
  // external
  peers: {},
  activeSpeaker: { producerId: null, volume: null, peerId: null },
  // internal
  transports: {},
  producers: [],
  consumers: []
}

const tls = {
  cert: fs.readFileSync(path.resolve(__dirname, "..", process.env.CERT)),
  key: fs.readFileSync(path.resolve(__dirname, "..", process.env.KEY)),
  requestCert: false,
  rejectUnauthorized: false
}

const clients = []

export default class SocketWebRTCServerTransport implements NetworkTransport {
  roomState = defaultRoomState
  supportsMediaStreams: false

  sendAllReliableMessages(): void {
    // TODO: Analyze, we might want to route messages better to only specific clients
    while (!MessageQueue.instance.outgoingReliableQueue.empty) {
      const message = MessageQueue.instance.outgoingReliableQueue.pop
      console.log(message)
      io.emit(MessageTypes.ReliableMessage as any, message)
    }
  }

  public async initialize(address = "https://localhost", port = 3001): Promise<void> {
    if (!config.mediasoup.webRtcTransport.listenIps.includes(address)) config.mediasoup.webRtcTransport.listenIps.push(address)
    await this.startMediasoup()

    // start https server
    console.log("Starting Express")
    server = https.createServer(tls, expressApp)
    server.on("error", e => console.error("https server error,", e.message))
    server.listen(address, port, () => console.log(`https server listening on port ${port}`))

    // Start Websockets
    console.log("Starting websockets")
    io = socketIO(server)

    // every 5 seconds, check for inactive clients and send them into cyberspace
    setInterval(() => {
      for (let id = 0; id < clients.length; id++) if (Date.now() - clients[id].lastSeenTs > 10000) console.log("Culling inactive user with id", id)
    }, 5000)

    io.on(MessageTypes.ConnectionRequest, socket => {
      console.log("User " + socket.id + " connected, there are " + io.engine.clientsCount + " clients connected")

      //Add a new client indexed by his id
      clients.push(socket.id)
      // Respond to initialization request with a list of clients
      socket.emit(MessageTypes.InitializationResponse, socket.id, Object.keys(clients))

      //Update everyone that the number of users has changed
      io.sockets.emit(MessageTypes.ClientConnected, io.engine.clientsCount, socket.id, Object.keys(clients))

      // On heartbeat received from client
      socket.on(MessageTypes.Heartbeat, () => {
        if (clients[socket.id]) clients[socket.id].lastSeenTs = Date.now()
        else console.log("Receiving message from peer who isn't in client list")
      })

      // Handle the disconnection
      socket.on(MessageTypes.DisconnectionRequest, () => {
        //Delete this client from the object
        delete clients[socket.id]
        io.sockets.emit(MessageTypes.ClientDisconnected as any, socket.id, Object.keys(clients))
        console.log("User " + socket.id + " diconnected, there are " + io.engine.clientsCount + " clients connected")
      })

      // If a reliable message is received, add it to the queue
      socket.on(MessageTypes.ReliableMessage as any, (message: Message) => {
        MessageQueue.instance.incomingReliableQueue.add(message)
      })

      //*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//*//
      // Mediasoup Signaling:
      // --> /signaling/sync
      // client polling endpoint. send back our 'peers' data structure
      socket.on(MessageTypes.SynchronizationRequest, async (data, callback) => {
        // make sure this peer is connected. if we've disconnected the
        // peer because of a network outage we want the peer to know that
        // happened, when/if it returns
        if (!this.roomState.peers[socket.id]) throw new Error("not connected")

        // update our most-recently-seem timestamp -- we're not stale!
        this.roomState.peers[socket.id].lastSeenTs = Date.now()

        callback({
          peers: this.roomState.peers
        })
      })

      // --> /signaling/join-as-new-peer
      // adds the peer to the roomState data structure and creates a
      // transport that the peer will use for receiving media. returns
      // router rtpCapabilities for mediasoup-client device initialization
      socket.on(MessageTypes.JoinWorldRequest, async (data, callback) => {
        const peerId = socket.id
        const now = Date.now()
        console.log("Join world request", peerId)

        this.roomState.peers[peerId] = {
          joinTs: now,
          lastSeenTs: now,
          media: {},
          consumerLayers: {},
          stats: {}
        }

        callback({ routerRtpCapabilities: router.rtpCapabilities })
      })

      // --> /signaling/leave
      // removes the peer from the roomState data structure and and closes
      // all associated mediasoup objects
      socket.on(MessageTypes.LeaveWorldRequest, async (data, callback) => {
        console.log("leave", socket.id)
        await this.closePeer(socket.id)
        callback({ left: true })
      })

      // --> /signaling/create-transport
      // create a mediasoup transport object and send back info needed
      // to create a transport object on the client side
      socket.on(MessageTypes.WebRTCTransportCreateRequest, async (data, callback) => {
        const peerId = socket.id
        const { direction } = data
        console.log("WebRTCTransportCreateRequest", peerId, direction)

        const transport = await this.createWebRtcTransport({ peerId, direction })
        this.roomState.transports[transport.id] = transport

        const { id, iceParameters, iceCandidates, dtlsParameters } = transport
        callback({
          transportOptions: {
            id,
            iceParameters,
            iceCandidates,
            dtlsParameters
          }
        })
      })

      // --> /signaling/connect-transport
      // called from inside a client's `transport.on('connect')` event
      // handler.
      socket.on(MessageTypes.WebRTCTransportConnectRequest, async (data, callback) => {
        const { transportId, dtlsParameters } = data,
          transport = this.roomState.transports[transportId]
        console.log("WebRTCTransportConnectRequest", socket.id, transport.appData)
        await transport.connect({ dtlsParameters })
        callback({ connected: true })
      })

      // called by a client that wants to close a single transport (for
      // example, a client that is no longer sending any media).
      socket.on(MessageTypes.WebRTCTransportCloseRequest, async (data, callback) => {
        console.log("close-transport", socket.id, transport.appData)
        const { transportId } = data
        transport = this.roomState.transports[transportId]
        await this.closeTransport(transport)
        callback({ closed: true })
      })

      // called by a client that is no longer sending a specific track
      socket.on(MessageTypes.WebRTCCloseProducerRequest, async (data, callback) => {
        const { producerId } = data,
          producer = this.roomState.producers.find(p => p.id === producerId)
        console.log("WebRTCCloseProducerRequest", socket.id, producer.appData)
        await this.closeProducerAndAllPipeProducers(producer, socket.id)
        callback({ closed: true })
      })

      // called from inside a client's `transport.on('produce')` event handler.
      socket.on(MessageTypes.WebRTCSendTrackRequest, async (data, callback) => {
        const peerId = socket.id
        const { transportId, kind, rtpParameters, paused = false, appData } = data,
          transport = this.roomState.transports[transportId]

        const producer = await transport.produce({
          kind,
          rtpParameters,
          paused,
          appData: { ...appData, peerID: peerId, transportId }
        })

        // if our associated transport closes, close ourself, too
        producer.on("transportclose", () => {
          console.log("producer's transport closed", producer.id)
          this.closeProducerAndAllPipeProducers(producer, peerId)
        })

        this.roomState.producers.push(producer)
        this.roomState.peers[peerId].media[appData.mediaTag] = {
          paused,
          encodings: rtpParameters.encodings
        }

        callback({ id: producer.id })
      })

      // --> /signaling/recv-track
      // create a mediasoup consumer object, hook it up to a producer here
      // on the server side, and send back info needed to create a consumer
      // object on the client side. always start consumers paused. client
      // will request media to resume when the connection completes
      socket.on(MessageTypes.WebRTCReceiveTrackRequest, async (data, callback) => {
        const { mediaPeerId, mediaTag, rtpCapabilities } = data
        const peerId = socket.id
        const producer = this.roomState.producers.find(p => p.appData.mediaTag === mediaTag && p.appData.peerId === mediaPeerId)
        if (!router.canConsume({ producerId: producer.id, rtpCapabilities })) {
          const msg = `client cannot consume ${mediaPeerId}:${mediaTag}`
          console.error(`recv-track: ${peerId} ${msg}`)
          callback({ error: msg })
          return
        }

        const transport = Object.values(this.roomState.transports).find(
          t => (t as any).appData.peerId === peerId && (t as any).appData.clientDirection === "recv"
        )

        const consumer = await (transport as any).consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true, // see note above about always starting paused
          appData: { peerId, mediaPeerId, mediaTag }
        })

        // need both 'transportclose' and 'producerclose' event handlers,
        // to make sure we close and clean up consumers in all
        // circumstances
        consumer.on("transportclose", () => {
          console.log(`consumer's transport closed`, consumer.id)
          this.closeConsumer(consumer)
        })
        consumer.on("producerclose", () => {
          console.log(`consumer's producer closed`, consumer.id)
          this.closeConsumer(consumer)
        })

        // stick this consumer in our list of consumers to keep track of,
        // and create a data structure to track the client-relevant state
        // of this consumer
        this.roomState.consumers.push(consumer)
        this.roomState.peers[peerId].consumerLayers[consumer.id] = {
          currentLayer: null,
          clientSelectedLayer: null
        }

        // update above data structure when layer changes.
        consumer.on("layerschange", layers => {
          console.log(`consumer layerschange ${mediaPeerId}->${peerId}`, mediaTag, layers)
          if (this.roomState.peers[peerId] && this.roomState.peers[peerId].consumerLayers[consumer.id]) {
            this.roomState.peers[peerId].consumerLayers[consumer.id].currentLayer = layers && layers.spatialLayer
          }
        })

        callback({
          producerId: producer.id,
          id: consumer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          type: consumer.type,
          producerPaused: consumer.producerPaused
        })
      })

      // --> /signaling/pause-consumer
      // called to pause receiving a track for a specific client
      socket.on(MessageTypes.WebRTCPauseConsumerRequest, async (data, callback) => {
        const { consumerId } = data,
          consumer = this.roomState.consumers.find(c => c.id === consumerId)
        console.log("pause-consumer", consumer.appData)
        await consumer.pause()
        callback({ paused: true })
      })

      // --> /signaling/resume-consumer
      // called to resume receiving a track for a specific client
      socket.on(MessageTypes.WebRTCResumeConsumerRequest, async (data, callback) => {
        const { consumerId } = data,
          consumer = this.roomState.consumers.find(c => c.id === consumerId)
        console.log("resume-consumer", consumer.appData)
        await consumer.resume()
        callback({ resumed: true })
      })

      // --> /signalign/close-consumer
      // called to stop receiving a track for a specific client. close and
      // clean up consumer object
      socket.on(MessageTypes.WebRTCCloseConsumerRequest, async (data, callback) => {
        const { consumerId } = data,
          consumer = this.roomState.consumers.find(c => c.id === consumerId)
        console.log("WebRTCCloseConsumerRequest", data)
        await this.closeConsumer(consumer)
        callback({ closed: true })
      })

      // --> /signaling/consumer-set-layers
      // called to set the largest spatial layer that a specific client
      // wants to receive
      socket.on(MessageTypes.WebRTCConsumerSetLayersRequest, async (data, callback) => {
        const { consumerId, spatialLayer } = data,
          consumer = this.roomState.consumers.find(c => c.id === consumerId)
        console.log("consumer-set-layers", spatialLayer, consumer.appData)
        await consumer.setPreferredLayers({ spatialLayer })
        callback({ layersSet: true })
      })

      // --> /signaling/pause-producer
      // called to stop sending a track from a specific client
      socket.on(MessageTypes.WebRTCCloseProducerRequest, async (data, callback) => {
        const { producerId } = data,
          producer = this.roomState.producers.find(p => p.id === producerId)
        console.log("pause-producer", producer.appData)
        await producer.pause()
        this.roomState.peers[socket.id].media[producer.appData.mediaTag].paused = true
        callback({ paused: true })
      })

      // --> /signaling/resume-producer
      // called to resume sending a track from a specific client
      socket.on(MessageTypes.WebRTCResumeProducerRequest, async (data, callback) => {
        const { producerId } = data,
          producer = this.roomState.producers.find(p => p.id === producerId)
        console.log("resume-producer", producer.appData)
        await producer.resume()
        this.roomState.peers[socket.id].media[producer.appData.mediaTag].paused = false
        callback({ resumed: true })
      })
    })
  }

  // start mediasoup with a single worker and router
  async startMediasoup() {
    console.log("Starting mediasoup")
    // Initialize roomstate
    this.roomState = defaultRoomState
    worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    })

    worker.on("died", () => {
      console.error("mediasoup worker died (this should never happen)")
      process.exit(1)
    })

    const mediaCodecs = config.mediasoup.router.mediaCodecs
    router = await worker.createRouter({ mediaCodecs })
  }

  closePeer(peerId) {
    console.log("closing peer", peerId)
    for (const [, transport] of Object.entries(this.roomState.transports))
      if ((transport as any).appData.peerId === peerId) this.closeTransport(transport)

    delete this.roomState.peers[peerId]
  }

  async closeTransport(transport) {
    console.log("closing transport", transport.id, transport.appData)

    // our producer and consumer event handlers will take care of
    // calling closeProducer() and closeConsumer() on all the producers
    // and consumers associated with this transport
    await transport.close()

    // so all we need to do, after we call transport.close(), is update
    // our roomState data structure
    delete this.roomState.transports[transport.id]
  }

  async closeProducer(producer) {
    console.log("closing producer", producer.id, producer.appData)
    await producer.close()

    // remove this producer from our roomState.producers list
    this.roomState.producers = this.roomState.producers.filter(p => p.id !== producer.id)

    // remove this track's info from our roomState...mediaTag bookkeeping
    if (this.roomState.peers[producer.appData.peerId]) delete this.roomState.peers[producer.appData.peerId].media[producer.appData.mediaTag]
  }

  async closeProducerAndAllPipeProducers(producer, peerId) {
    console.log("closing producer", producer.id, producer.appData)

    // first, close all of the pipe producer clones
    console.log("Closing all pipe producers for peer with id", peerId)

    // remove this producer from our roomState.producers list
    this.roomState.producers = this.roomState.producers.filter(p => p.id !== producer.id)

    // finally, close the original producer
    await producer.close()

    // remove this producer from our roomState.producers list
    this.roomState.producers = this.roomState.producers.filter(p => p.id !== producer.id)

    // remove this track's info from our roomState...mediaTag bookkeeping
    if (this.roomState.peers[producer.appData.peerId]) delete this.roomState.peers[producer.appData.peerId].media[producer.appData.mediaTag]
  }

  async closeConsumer(consumer) {
    console.log("closing consumer", consumer.id, consumer.appData)
    await consumer.close()

    // remove this consumer from our roomState.consumers list
    this.roomState.consumers = this.roomState.consumers.filter(c => c.id !== consumer.id)

    // remove layer info from from our roomState...consumerLayers bookkeeping
    if (this.roomState.peers[consumer.appData.peerId]) delete this.roomState.peers[consumer.appData.peerId].consumerLayers[consumer.id]
  }

  async createWebRtcTransport({ peerId, direction }) {
    const { listenIps, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport

    const transport = await router.createWebRtcTransport({
      listenIps: listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: initialAvailableOutgoingBitrate,
      appData: { peerId, clientDirection: direction }
    })

    return transport
  }
}