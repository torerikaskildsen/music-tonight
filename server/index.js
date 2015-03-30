/*
TODO:
uniquify on track (multiple incarnations of same artist)
*/

var fs = require('fs');
var Q = require('q');
var rdiolib = require('rdio');
var request = require('request');
var restify = require('restify');
var mysql = require('mysql2');
var url = require('url');
var cookieparser = require('restify-cookies');
var requireDir = require('require-dir');
var uuid = require('node-uuid');
var configFiles = requireDir('./config');

var config = {};
var fileNames = Object.keys(configFiles);
fileNames.sort();
fileNames.forEach(function(fileName) {
    var configObj = configFiles[fileName];
    for (var attrname in configObj) { config[attrname] = configObj[attrname]; }
});

config.RDIO.callback_url = config.HOST_PREFIX + config.RDIO.callback_url;
config.SPOTIFY.callback_url = config.HOST_PREFIX + '/api/music_svc_callback';

var rdio = rdiolib(config.RDIO);
var pool = mysql.createPool(config.MYSQL);


pool.boundQuery = function() {
    var deferred = Q.defer();
    var qArgs = Array.prototype.slice.call(arguments, 0);
    var cb = function(err, connection) {
	    if (err) {
	        deferred.reject(err);
	    } else {
	        qArgs.push(function(err, rows) {
		        if (err) {
		            deferred.reject(err);
		        } else {
		            deferred.resolve(rows);
		        }
		        connection.release();
	        });
	        connection.query.apply(connection, qArgs);
	    }
    }
    pool.getConnection(cb);
    return deferred.promise;
};

function mysqlStore(pool, table) {
    var sql = 'CREATE TABLE IF NOT EXISTS '+table+' (k VARCHAR(255) PRIMARY KEY, v VARCHAR(21000)) ENGINE=innodb'
    return pool.boundQuery(sql).then(function () {
	    var openRequests = {};
	    return {
	        'get': function(key) {
		        if (! openRequests[key]) {
		            openRequests[key] = pool.boundQuery('SELECT k,v FROM ' + table + ' WHERE k=? COLLATE utf8_general_ci', key).then(function(rows) {
			            if (rows.length == 0) return undefined;
			            ret = JSON.parse(rows[0].v);
                        return ret;
		            }).fin(function() {
			            delete openRequests[key];
		            });
		        }
		        return openRequests[key];
	        },
	        'iter': function(callback) {
		        var deferred = Q.defer();
		        var cb = function(err, conn) {
		            if (err) {
			            deferred.reject(err);
			            return;
		            }
		            var query = conn.query('SELECT k,v from ' + table);
		            var hadError = false;
		            query.on('error', function(err) {
			            hadError=true;
			            deferred.reject(err);
		            });
		            query.on('end', function() {
			            if (! hadError) deferred.resolve();
			            conn.release();
		            });
		            query.on('result', function(row) {
			            conn.pause();
			            Q.fcall(callback, row.k, row.v).fin(function(){conn.resume();}).done();
		            });
		        };
		        pool.getConnection(cb);
		        return deferred.promise;
	        },
	        'set': function(key, val) {
		        var sql = 'INSERT INTO ' + table + ' (k,v) VALUES (?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)';
		        return pool.boundQuery(sql, [key, JSON.stringify(val)]);
	        }
	    };
    });
}

function http(options) {
    options.encoding = 'utf8';
    var deferred = Q.defer();
    request(options, function(err, httpResponse, body) {
	if (err) {
	    deferred.reject(err);
	} else {
	    deferred.resolve(body);
	}
    });
    return deferred.promise;
}

function parse_hash_query(url) {
    var args = {};
    var hash = url.replace(/^[^\#]*#/g, '');
    var all = hash.split('&');
    all.forEach(function(keyvalue) {
	var idx = keyvalue.indexOf('=');
	var key = keyvalue.substring(0, idx);
	var val = keyvalue.substring(idx + 1);
	args[key] = val;
    });
    return args;
}

function formatDate(dt) {
    return dt.toISOString().substring(0, 19);
}

function rdio_get_access_token(oauth_token, oauth_secret, oauth_verifier) {
    var deferred = Q.defer();
    rdio.getAccessToken(
	oauth_token, oauth_secret, oauth_verifier,
	function(error, access_token, access_token_secret, results) {
	    if (error) {
		deferred.reject(error);
	    } else {
		deferred.resolve({'token': access_token, 'secret': access_token_secret});
	    }
	});
    return deferred.promise;
}

function make_rdio_api_fn(token, token_secret) {
    return function(args) {
	var deferred = Q.defer();
	rdio.api(token, token_secret, args, function(err, data, response) {
            if (err) {
		deferred.reject(err);
            } else {
		deferred.resolve(JSON.parse(data)['result']);
            }
	});
	return deferred.promise;
    };
}

function make_spotify_api_fn(access_token) {
    return {
	'getUsername': function() {
	    var url = 'https://api.spotify.com/v1/me';
	    return http({'method':'get', 'url':url, 'headers': {'Authorization': 'Bearer ' + access_token}, 'json':true}).
		then(function(r) { return r.id; });
	},
	'createPlaylist': function(username, name) {
	    var url = 'https://api.spotify.com/v1/users/' + username + '/playlists';
	    var data = {'name': name, 'public': false};
	    var headers = {
		'Authorization': 'Bearer ' + access_token,
		'Content-Type': 'application/json'
	    }
	    return http({'method':'post', 'url':url, 'body':data, json:true, headers: headers}).
		then(function(r) {return r.id;});
	},
	'addTracksToPlaylist': function(username, playlist, tracks) {
	    var url = 'https://api.spotify.com/v1/users/' + username +
		'/playlists/' + playlist +
		'/tracks';
	    var headers = {
		'Authorization': 'Bearer ' + access_token,
		'Content-Type': 'application/json'
            };
	    return http({method:'post', url:url, body:tracks, json:true, headers: headers}).
		then(function(r) {return r.id;});
	}
    };
}

function fetchEvents(opts, range) {
    var zipcode = opts.zipcode;
    var latlon = opts.latlon;
    var daysout = opts.daysout;
    var maxmiles = opts.maxmiles;
    var onlyavailable = opts.onlyavailable;
    range = (range > maxmiles) ? maxmiles : range;
    var dt = new Date();
    var startdt = formatDate(new Date(dt.getTime() - 2 * 3600 * 1000));
    var enddt = formatDate(new Date(dt.getTime() + ((daysout - 1) * 24 - 2) * 3600 * 1000));

    console.log('input', zipcode, opts.clientIp, latlon, startdt, enddt);
    var promise;
    if (true) {
	var uri = 'http://api.bandsintown.com/events/search?app_id=musictonight.millstonecw.com&format=json&per_page=50';
	if (latlon) {
	    uri += '&location=' + latlon;
	} else {
	    if (opts.clientIp !== '127.0.0.1') {
		uri += '&location=' + opts.clientIp;
	    } else {
		uri += '&location=40.7436300,-73.9906270';
	    }
	}
	uri += '&radius=' + range;
	uri += '&date=' + startdt.substring(0, 10) + ',' + enddt.substring(0, 10);
	console.log(uri);
	promise = http({method:'get', uri:uri, json:true}).then(function(events) {
	    if (events.errors) {
		var errors = events.errors;
		if (errors[0] === 'Unknown Location') {
		    throw new Error('client error: cannot_geo_ip');
		} else {
		    throw new Error(events.errors);
		}
	    }
	    if (onlyavailable) {
		events = events.filter(function(e){e.ticket_status === 'available'});
	    }
	    events.forEach(function(event) {
		var month = parseInt(event.datetime.substring(5, 7));
		var day = parseInt(event.datetime.substring(8, 10));
		event.datestring = month + '-' + day;
		event.datetime_local = event.datetime;
		event.performers = event.artists;
		delete event.artists;
	    });
	    return events;
	});
    } else {
	var uri = config.SEATGEEK_EVENTS_PREFIX + '&taxonomies.name=concert&sort=score.desc&per_page=50&range='+range+'mi&datetime_utc.gte='+startdt+'&datetime_utc.lt='+enddt;
	if (latlon) {
	    var parts = latlon.split(',');
	    uri += '&lat=' + parts[0] + '&lon=' + parts[1];
	} else {
	    var geoip = (zipcode !== undefined && zipcode !== '00000') ? zipcode : opts.clientIp;
	    uri += '&geoip=' + geoip;
	}
	promise = http({method:'get', uri:uri, json:true}).then(function(response) {
	    return response.events;
	});
    }
    return promise.then(function(events) {
	var num_events = events.length;
	var target_count = Math.min(50, Math.max(4, Math.round(600 / range)));
	console.log('results at range ', range, ' : ', num_events, ' (target is:', target_count, ')');
	if (range >= maxmiles || num_events >= target_count) {
	    var performer_map = {};
	    events = events.slice(0, 40);
	    events.forEach(function(event) {
		event.performers = event.performers.slice(0, 3);
		event.performers.forEach(function(performer) {
		    performer_map[performer.name]=event;
		});
	    });
	    return performer_map;
	} else {
	    var multiplier = Math.sqrt((target_count + 1) / (num_events + 1));
	    if (multiplier < 1.1) { multiplier = 1.1; }
	    if (multiplier > 2.0) { multiplier = 2.0; }
	    return fetchEvents(opts, 1 + Math.ceil(range * multiplier));
	}
    });
}

hashCode = function(string) {
  var hash = 0, i, chr, len;
  if (string.length == 0) return hash;
  for (i = 0, len = string.length; i < len; i++) {
    chr   = string.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

var NUM_TRACKS_CACHED = 7;

function spotifyArtist(performer) {
    var uri = config.SPOTIFY.artist_search_prefix + 'limit=5&q='+encodeURIComponent('"'+performer+'"');
    return http({uri:uri, method:'get', json:true}).then(
	function(response) {
	    var artists = response.artists.items;
	    if (artists.length == 0) {
		console.log('no artists found for: '+performer);
		return null;
	    }
	    artists = artists.filter(function(artist) { return artist.name === performer });
	    if (artists.length == 0) {
		console.log('no name match for artist: '+performer);
		return null;
	    }
	    return artists[0];
	}
    ).then(
	function(artist) {
	    if (artist === null) return null;
	    uri = config.SPOTIFY.artist_prefix + artist.id + '/top-tracks?country=US';
	    return http({uri:uri, method:'get', json:true}).then(function(tracks_response) {
		var tracks = tracks_response.tracks;
		if (tracks.length === 0) {
		    console.log('no tracks for artist: '+performer);
		    return null;
		}
		function score_track(t) { return (t.popularity + 10.0) / (t.artists.length * t.artists.length); }
		tracks.sort(function(a,b) {return score_track(b) - score_track(a);});
		tracks = tracks.slice(0, NUM_TRACKS_CACHED);
		tracks = tracks.map(function(item) {
		    return {name: item.name, artist: performer, uri: item.uri, popularity: item.popularity, key: item.uri};
		});
		artist.tracks = tracks;
		return artist;
	    });
	}
    );
}

var rdio_cps = {'tm':0, 'ct':0};

function rdioArtist(performer) {
    var api = make_rdio_api_fn(undefined, undefined);
    function make_promise() {
	return api({'method': 'search','query':performer,'types':'artist','extras':'-*,key,name'}).then(function(artist_result) {
	    var hits = artist_result.results.filter(function(a){return a.name === performer;});
	    if (hits) {
		return hits[0];
	    } else {
		console.log('Artist not found on rdio ', performer, ' options ', artist_result.results);
		return null;
	    }
	}).then(function(artist) {
	    if (! artist) return null;
	    return api(
		{'method':'getTracksForArtist', 
		 'artist': artist.key, 
		 'count':NUM_TRACKS_CACHED, 
		 'extras':'-*,key,name'
		}
	    ).then(function(tracks) {
		if (!tracks) {
		    console.log('No tracks found on rdio for ', performer);
		    return null;
		}
		tracks = tracks.map(function(item) {
		    return {name: item.name, artist: performer, key: item.key};
		});
		artist.tracks = tracks;
		return artist;
	    });
	});
    }
    var dt_to_second = new Date().toISOString().substring(0,19);
    if (rdio_cps.tm !== dt_to_second) {
	rdio_cps.tm = dt_to_second;
	rdio_cps.ct = 0;
	return make_promise();
    } else {
	rdio_cps.ct += 1;
	// aim for 5 per second(ish)
	var delay = ((rdio_cps.ct - 1) / 5) * 1000
	console.log('rdio throttle kick-in', delay);
	return Q.delay(delay).then(make_promise);
    }
}


function getMusic(eventOptions, trackOptions, artistStore) {
    var maxTracksPerArtist = trackOptions.maxTracksPerArtist;
    return fetchEvents(eventOptions, 2).then(function(performer_map) {
	var playlistName = formatDate(new Date()).substring(0, 10) + '-music-tonight';
	var performers = Object.keys(performer_map);
	var tracksPerArtist = Math.round(22.0 / performers.length);
	tracksPerArtist = Math.max(1, Math.min(maxTracksPerArtist, tracksPerArtist));
	var promises = performers.map(function(performer) {
	    var service = trackOptions.service;
            var artistCacheKey = service+':'+performer;
            return artistStore.get(artistCacheKey).then(function(data) {
		if (data) {
		    return JSON.parse(data);
		} else {
                    var fetchfn = {'spotify': spotifyArtist, 'rdio': rdioArtist}[service];
                    return fetchfn(performer).then(function(result){
			artistStore.set(artistCacheKey, JSON.stringify(result)).done();
			return result;
		    });
		}
	    }).then(function(artist){
		if (! artist) { return null; }
		artist.tracks.forEach(function(track) {
		    track.event = performer_map[performer];
		    if (track.name.split(' ').length > 6) {
			track.name = track.name.split(' ', 6).join(' ') + '...';
		    }
		});
		return artist.tracks.slice(0, tracksPerArtist);
	    });
	});
	return Q.all(promises).then(function(track_data) {
	    var tracks = [];
	    track_data.forEach(function(result) {
		if (result) {
		    result.forEach(function(track){ tracks.push(track); });
		}
	    });
	    return {name: playlistName, tracks:tracks};
	});
    });
}

function promised(fn) {
    return function(req, res, next) {
	fn(req, res, next).then(function(result) {
	    res.send(200, result);
	}, function(err) {
	    console.log('returning error', err);
	    if ((err+'').match(/client error/)) {
		res.send(400, err);
	    } else {
		console.log(err.stack);
		res.send(500, err);
	    }
	}).done();
    };
}

function clientError(desc) {
    throw new Error('client error: ' + desc);
}

function makeServer(artistStore) {
    
    server = restify.createServer();
    
    server.on('uncaughtException', function(req, res, route, err) {
	console.log(err.stack);
	res.send(err);
    });
    
    server.use(restify.gzipResponse());
    server.use(cookieparser.parse);

    server.use( // CORS
	function crossOrigin(req,res,next){
	    res.header("Access-Control-Allow-Origin", "*");
	    res.header("Access-Control-Allow-Headers", "X-Requested-With");
	    return next();
	}
    );

    server.use(restify.bodyParser());
    server.use(restify.queryParser());

    server.get('/api/playlist', promised(function(req, res) {
	console.log('get playlist', req.params);
	var clientIp = req.headers['x-forwarded-for'] || 
	    req.connection.remoteAddress || 
	    req.socket.remoteAddress ||
	    req.connection.socket.remoteAddress;
	clientIp = clientIp.split(',')[0];

	var language = 'en-US';
	var acceptLanguages = req.headers['accept-language'];
	if (acceptLanguages) {
	    language = acceptLanguages.split(/[\,\;]/)[0];
	}

	var daysout = (req.params.daysout) ? parseInt(req.params.daysout) : 1;
	var maxmiles = (req.params.maxmiles) ? parseInt(req.params.maxmiles) : 125;
	var onlyavailable = (req.params.onlyavailable) ? (req.params.onlyavailable === 'true') : false;
	var eventOptions = {
	    zipcode: req.params.zip_code,
	    clientIp: clientIp,
	    latlon: req.params.latlon,
	    daysout: daysout,
	    maxmiles: maxmiles,
	    onlyavailable: onlyavailable
	};
	var trackOptions = {
	    service: (req.params.service) ? req.params.service : 'spotify',
	    maxTracksPerArtist: (req.params.maxartisttracks) ? parseInt(req.params.maxartisttracks) : 2
	};
	return getMusic(eventOptions, trackOptions, artistStore).then(function(result) {
	    result.language = language;
	    return result;
	});
    }));


    var transient_svc_auth = {};

    server.post('/api/music_svc_auth', function(req, res) {
        var service = req.params.service;
        var trackKeys = req.params.track_keys;
        var myKey = uuid.v4();

        transient_svc_auth[myKey] = {'track_keys': trackKeys, 'service': service};
        res.setCookie('svc_auth_key', myKey);
        if (service === 'spotify') {
            var uri = 'https://accounts.spotify.com/authorize?client_id=' + config.SPOTIFY.client_id +
		'&state=' + myKey +
                '&response_type=code' +
                '&scope=playlist-read-private%20playlist-modify%20playlist-modify-private' +
                '&redirect_uri=' + config.SPOTIFY.callback_url;
            res.header('Location', uri);
            res.send(302);
        } else if (service === 'rdio') {
            rdio.getRequestToken(function(error, oauth_token, oauth_token_secret, results){
                if (! error) {
                    transient_svc_auth[myKey]['oauth_secret'] = oauth_token_secret;
                    transient_svc_auth[myKey]['oauth_token'] = oauth_token;
                    var login = results['login_url'] + '?oauth_token=' + oauth_token + '&state='+myKey;
                    res.header('Location', login);
                    res.send(302);
                } else {
                    console.log('error requesting login token from rdio: ', error);
                    res.send(500);
                }
            });
        } else {
            res.send(400, 'Invalid service');
        }
    });

    server.get('/api/music_svc_callback', function(req, res) {
	var myKey = req.cookies.svc_auth_key;
        var info = transient_svc_auth[myKey];
        var trackKeys = JSON.parse(info.track_keys);
	var playlist_title = formatDate(new Date()).substring(0,10) + '-music-tonight';
        var openlink = '';

	var promise;
        if (info.service === 'spotify') {
	    var code = req.query.code || null;
	    var state = req.query.state || null;
	    if (state === null || state !== myKey) {
		throw new Error('state mismatch: state:'+state+' vs cookie:'+myKey); 
	    }
	    res.setCookie('svc_auth_key', '');
	    var authOptions = {
		url: 'https://accounts.spotify.com/api/token',
		form: {
		    code: code,
		    redirect_uri: config.SPOTIFY.callback_url,
		    grant_type: 'authorization_code'
		},
		headers: {
		    'Authorization': 'Basic ' + (new Buffer(config.SPOTIFY.client_id + ':' + config.SPOTIFY.client_secret).toString('base64'))
		},
		method: 'post',
		json: true
	    };
	    console.log('authoptions', authOptions);
	    promise = http(authOptions).then(function(response) {
		console.log('response', response);
		return response.access_token;
	    }).then(function(access_token) {
		var api = make_spotify_api_fn(access_token);
		return api.getUsername().then(function(username) {
		    return api.createPlaylist(username, playlist_title).then(function(playlist_id) {
			return urls = {http: 'https://play.spotify.com/user/'+username+'/playlist/'+playlist_id,
				       app: 'spotify:user:'+username+':playlist:'+playlist_id};
			var uris = playlist_tracks.map(function(track){return track.uri;});
			return mtSpotify.addTracksToPlaylist(username, playlist_id, uris).then(function() {
			    return urls;
			});
		    });
		});
	    });

	    
        } else if (info.service === 'rdio') {
	    promise = rdio_get_access_token(info.oauth_token, info.oauth_secret, req.params.oauth_verifier).then(
		function(result) {
                    access_token = result.token
                    access_token_secret = result.secret;

                    console.log('ok', info, 'result', result, access_token, access_token_secret);

                    var api = make_rdio_api_fn(access_token, access_token_secret);
		    var payload = {'method': 'createPlaylist', 
				   'name': playlist_title, 
				   'description': 'A playlist of local artists playing near you, now.',
				   'isPublished': 'false',
				   'tracks': trackKeys.join(',')};
		    console.log('api create ', payload, ' with ', access_token, access_token_secret);
		    return api(payload);
		}
	    ).then(
		function(result) {
		    return {'http': result.url};
		}
	    );
        } else {
	    res.send(400, 'Invalid service');
	    return;
	}
	promise.then(
	    function(links) {
		res.header('Location', '/#http=' + encodeURIComponent(links.http) +
			   '&app=' + encodeURIComponent(links.app));
		res.send(302);
	    },
	    function(err) {
		console.log('could not create playlist ', err);
		res.send(500);
	    }).done();
    });

    return server;
}

mysqlStore(pool, 'artists').then(function(artistStore) {
    var server = makeServer(artistStore);
    server.listen(11809, function() {
	console.log('%s listening at %s', server.name, server.url);
    });
}).done();
