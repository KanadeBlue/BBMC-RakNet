const dgram = require('dgram');
const EventEmitter = require('events');
const BinaryStream = require('bbmc-binarystream');
const InternetAddress = require('./misc/InternetAddress');
const Identifiers = require('./Identifiers');
const Connection = require('./Connection');
const UnconnectedPing = require('./packet/UnconnectedPing');
const UnconnectedPong = require('./packet/UnconnectedPong');
const OpenConnectionRequestOne = require('./packet/OpenConnectionRequestOne');
const OpenConnectionRequestTwo = require('./packet/OpenConnectionRequestTwo');
const OpenConnectionReplyOne = require('./packet/OpenConnectionReplyOne');
const OpenConnectionReplyTwo = require('./packet/OpenConnectionReplyTwo');
const IncompatibleProtocolVersion = require('./packet/IncompatibleProtocolVersion');
const FrameSet = require('./packet/FrameSet');
const Ack = require('./packet/Ack');
const Nack = require('./packet/Nack');
const Packet = require('./packet/Packet');

/**
 * RakNetServer class
 * @extends EventEmitter
 */
class RakNetServer extends EventEmitter {
  /**
   * RakNetServer constructor
   * @param {InternetAddress} address - The server address
   * @param {number} protocolVersion - The protocol version
   */
  constructor(address, protocolVersion) {
    super();
    this.message = "";
    this.protocolVersion = protocolVersion;
    this.serverGUID = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    this.epoch = BigInt(Date.now());
    this.isRunning = true;
    this.connections = new Map();
    this.socket = dgram.createSocket(address.version === 4 ? 'udp4' : 'udp6');
    this.socket.on('message', (msg, rinfo) => {
      if (!this.isRunning) {
        this.socket.close();
        return;
      }
      try {
        this.handlePacket(new BinaryStream(msg), new InternetAddress(rinfo.address, rinfo.port, rinfo.family === 'IPv4' ? 4 : 6));
      } catch (err) {
        console.error(`Failed to handle packet: ${err}`);
      }
    });
    this.socket.bind(address.port, address.name);
    setInterval(() => {
      if (!this.isRunning) return;
      for (const connection of this.connections.values()) {
        connection.tick();
      }
    }, 10);
  }

  /**
   * Adds a new connection to the server
   * @param {InternetAddress} address - The address of the new connection
   * @param {number} mtuSize - The MTU size of the new connection
   */
  addConnection(address, mtuSize) {
    if (!this.connections.has(address.toString())) {
      this.connections.set(address.toString(), new Connection(address, mtuSize, this));
    }
  }

  /**
   * Removes a connection from the server
   * @param {InternetAddress} address - The address of the connection to remove
   */
  removeConnection(address) {
    this.connections.delete(address.toString());
  }

  /**
   * Gets an existing connection from the server
   * @param {InternetAddress} address - The address of the connection to get
   * @returns {Connection} The connection, or undefined if it does not exist
   */
  getConnection(address) {
    return this.connections.get(address.toString());
  }

  /**
   * Checks if a connection exists in the server
   * @param {InternetAddress} address - The address of the connection to check
   * @returns {boolean} True if the connection exists, false otherwise
   */
  hasConnection(address) {
    return this.connections.has(address.toString());
  }

  /**
   * Get how many milliseconds past since the server started
   * @returns {BigInt} The time in milliseconds
   */
  getTime() {
    return BigInt(Date.now()) - this.epoch;
  }
  
  /**
   * Sends a packet over the network
   * @param {Packet} packet - The packet to send
   * @param {InternetAddress} address - The address to send the packet to
   */
  sendPacket(packet, address) {
    if (packet instanceof Packet) {
      if (!packet.isEncoded) {
        packet.encode();
      }
      this.socket.send(packet.buffer, address.port, address.name);
    }
  }

  /**
   * Handles incoming packets
   * @param {BinaryStream} stream - The stream containing the packet data
   * @param {InternetAddress} address - The address the packet came from
   */
  handlePacket(stream, address) {
    let packetID = stream.readUnsignedByte();
    if (packetID == Identifiers.UNCONNECTED_PING) {
      let packet = new UnconnectedPing(stream.buffer);
      packet.decode();
      let newPacket = new UnconnectedPong();
      newPacket.clientTimestamp = packet.clientTimestamp;
      newPacket.serverGUID = this.serverGUID;
      newPacket.data = this.message;
      this.sendPacket(newPacket, address);
    } else if (packetID == Identifiers.OPEN_CONNECTION_REQUEST_ONE) {
      let packet = new OpenConnectionRequestOne(stream.buffer);
      packet.decode();
      if (packet.protocolVersion === this.protocolVersion) {
        let newPacket = new OpenConnectionReplyOne();
        newPacket.serverGUID = this.serverGUID;
        newPacket.useSecurity = false;
        newPacket.mtuSize = packet.mtuSize;
        this.sendPacket(newPacket, address);
      } else {
        let newPacket = new IncompatibleProtocolVersion();
        newPacket.protocolVersion = this.protocolVersion;
        newPacket.serverGUID = this.serverGUID;
        this.sendPacket(newPacket, address);
      }
    } else if (packetID == Identifiers.OPEN_CONNECTION_REQUEST_TWO) {
      let packet = new OpenConnectionRequestTwo(stream.buffer);
      packet.decode();
      let newPacket = new OpenConnectionReplyTwo();
      newPacket.serverGUID = this.serverGUID;
      newPacket.clientAddress = address;
      newPacket.mtuSize = packet.mtuSize;
      newPacket.useEncryption = false;
      this.sendPacket(newPacket, address);
      this.addConnection(address, packet.mtuSize);
    } else if (this.hasConnection(address)) {
      this.getConnection(address).lastReceiveTimestamp = Date.now();
      if (packetID == Identifiers.ACK) {
        let packet = new Ack(stream.buffer);
        packet.decode();
        this.getConnection(address).handleAck(packet);
      } else if (packetID == Identifiers.NACK) {
        let packet = new Nack(stream.buffer);
        packet.decode();
        this.getConnection(address).handleNack(packet);
      } else if (packetID >= 0x80 && packetID <= 0x8f) {
        let packet = new FrameSet(stream.buffer);
        packet.decode();
        this.getConnection(address).handleFrameSet(packet);
      }
    }
  }
}

module.exports = RakNetServer;
