// our required dependencies
var spawn = require('child_process').spawn;
var nopt = require('nopt');
var zmq = require('zmq');
var WebSocket = require('ws');
var osc = require('osc');

// some global variables
var stderr = process.stderr;
var output = process.stdin;
var feedBackSource = process.stdin; 

// parse command-line options
var knownOpts = { 
    "server" : [String, null],
    "zmq-port" : [Number, null],
    "osc-port" : [Number, null],
    "ws-port" : [Number, null],
    "password" : [String, null],
    "help": Boolean,
    "feedback": Boolean,
    "tidal": Boolean,
    "newlines-as-spaces" : Boolean
};

var shortHands = {
    "s" : ["--server"],
    "z" : ["--zmq-port"],
    "n" : ["--newlines-as-spaces"],
    "o" : ["--osc-port"],
    "w" : ["--ws-port"],
    "p" : ["--password"],
    "h" : ["--help"],
    "f" : ["--feedback"]
};

var parsed = nopt(knownOpts,shortHands,process.argv,2);

if(parsed['help']!=null) {
    stderr.write("extramuros client.js usage:\n");
    stderr.write(" --help (-h)               this help message\n");
    stderr.write(" --server (-s) [address]   address of server's downstream (default:localhost)\n");
    stderr.write(" --zmq-port (-z) [number]  TCP port on which to connect to server (default: 8001)\n");
    stderr.write(" --ws-port [number]        port for OSC WebSocket connection to server (default: 8002)\n");
    stderr.write(" --osc-port [number]       UDP port on which to receive OSC messages (default: none)\n");
    stderr.write(" --password [word] (-p)    password to authenticate messages to server\n");
    stderr.write(" --feedback (-f)           send feedback from stdin to server\n");
    stderr.write(" --tidal                   launch Tidal (ghci) and use its stdout as feedback\n");
    stderr.write(" --newlines-as-spaces (-n) converts any received newlines to spaces on stdout\n");
    process.exit(1);
}

if(process.argv.length<3) {
    stderr.write("extramuros: use --help to display available options\n");
}

// before setting up connections, set some defaults and look for problems
var newlines = parsed['newlines-as-spaces'];
var server = parsed['server'];
if(server == null) { server = "localhost"; }
var port = parsed['zmq-port'];
if(port == null) { port = 8001; }
var oscPort = parsed['osc-port'];
var wsPort = parsed['ws-port'];
var feedback = parsed['feedback'];
if((oscPort==null && feedback==null) && wsPort!=null) {
    stderr.write("Error: OSC forwarding and/or feedback must be present if --ws-port is set\n");
    process.exit(1);
}
if(wsPort==null && (oscPort!=null || feedback!=null)) { wsPort = 8002; }
var address = "tcp://" + server + ":" + (port.toString());
var wsAddress;
if(wsPort!=null) { wsAddress = "ws://" + server + ":" + (wsPort.toString()); }
var password = parsed['password'];
if(oscPort!=null && password == null) {
    stderr.write("Error: Password required if an OSC port is specified\n");
    process.exit(1);
}

var tidal;
if(parsed['tidal']!=null) {
    tidal = spawn('ghci', ['-XOverloadedStrings']);
    tidal.on('close', function (code) {
	stderr.write('Tidal process exited with code ' + code + "\n");
    });
    output = tidal.stdin;
    feedbackSource = tidal.stderr;
}

// connection #1: messages on 0mq socket from server to stdout (to be piped into a live coding language)
var sub = zmq.socket('sub');
sub.on('error',function (err) {
  stderr.write("extramuros: error event on socket: " + err + "\n");
});
sub.on('message',function (msg) {
  var s;
  if(newlines) { // convert newline sequences to whitespace
      s = msg.toString().replace(/\n|\n\r|\r\n|\r/g," ");
  }
  else { // leave newline sequences as is
      s = msg.toString();
  }
  // console.log(s); // JUST TESTING
  output.write(s+"\n");
  stderr.write(s+"\n");
});
stderr.write("extramuros: subscribing to " + address + "\n");
sub.connect(address);
sub.subscribe('');

// connection #2: (optionally) OSC messages received via UDP are forwarded to server on a WebSocket 
// connection #3: (optionally) feedback from stdin is forwarded to server on a WebSocket

var connectWs = function() {
    stderr.write("extramuros: connecting to " + wsAddress + "...\n");
    var ws = new WebSocket(wsAddress);
    var udp,oscFunction,feedbackFunction;
    oscFunction = function(m) {
	var n = {
	    'request': 'oscFromClient',
	    'password' : password,
	    'address': m.address,
	    'args': m.args
	};
	try { ws.send(JSON.stringify(n)); } 
	catch(e) {
	    stderr.write("warning: exception in WebSocket send\n");
	}
    }
    feedbackFunction = function(m) {
	var n = {
	    'request': 'feedback',
	    'password' : password,
	    'text': m.toString()
	};
	try { ws.send(JSON.stringify(n)); }
	catch(e) {
	    stderr.write("warning: exception in WebSocket send\n");
	}
    }
    ws.on('open',function() {
	stderr.write("extramuros: webSocket connection " + wsAddress + " opened\n");
	if(oscPort !=null) {
	    udp = new osc.UDPPort( { localAddress: "0.0.0.0",localPort: oscPort});
	    udp.on("message",oscFunction);
	    udp.open();
	}
	if(feedback != null) {
	    if(tidal != null) {
		tidal.stdout.addListener("data",feedbackFunction);
		tidal.stderr.addListener("data",feedbackFunction);
	    }
	}
    });
    ws.on('close',function() {
	stderr.write("extramuros: websocket connection " + wsAddress + " closed\n");
	if(oscPort!=null)udp.close();
	if(feedback!=null) {
	    tidal.stdout.removeListener("data",feedbackFunction);
	    tidal.stderr.removeListener("data",feedbackFunction);
	}
	setTimeout(connectWs,5000);
    });
    ws.on('error',function() {
	setTimeout(connectWs,5000);
    });
};
if(wsAddress != null) connectWs();

process.on('SIGINT', function() { sub.close(); ws.close(); } );
