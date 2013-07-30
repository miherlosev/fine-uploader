qq.s3.CompleteMultipartAjaxRequester = function(o) {
    "use strict";

    var requester,
        pendingCompleteRequests = {},
        validMethods = ["POST"],
        options = {
            method: "POST",
            endpointStore: null,
            signatureEndpoint: null,
            accessKey: null,
            maxConnections: 3,
            getKey: function(id) {},
            log: function(str, level) {}
        },
        getSignatureAjaxRequester;

    qq.extend(options, o);

    getSignatureAjaxRequester = new qq.s3.SignatureAjaxRequestor({
        endpoint: options.signatureEndpoint,
        cors: options.cors,
        log: options.log
    });


    // TODO remove code duplication among all ajax requesters
    if (qq.indexOf(validMethods, getNormalizedMethod()) < 0) {
        throw new Error("'" + getNormalizedMethod() + "' is not a supported method for S3 Initiate Multipart Upload requests!");
    }

    // TODO remove code duplication among all ajax requesters
    function getNormalizedMethod() {
        return options.method.toUpperCase();
    }

    function getHeaders(id, uploadId) {
        var headers = {},
            promise = new qq.Promise(),
            toSign;

        headers["x-amz-date"] = new Date().toUTCString();

        toSign = {multipartHeaders: getStringToSign(id, uploadId, headers["x-amz-date"])};

        // Ask the local server to sign the request.  Use this signature to form the Authorization header.
        getSignatureAjaxRequester.getSignature(id, toSign).then(function(response) {
            headers.Authorization = "AWS " + options.accessKey + ":" + response.signature;
            promise.success(headers);
        }, promise.failure);

        return promise;
    }

    function getStringToSign(id, uploadId, utcDateStr) {
        var endpoint = options.endpointStore.getEndpoint(id),
            bucket = qq.s3.util.getBucket(endpoint);

        return "POST\n\napplication/xml\n\nx-amz-date:" + utcDateStr + "\n/" + bucket + "/" + getEndOfUrl(id, uploadId);
    }

    /**
     * Called by the base ajax requester when the response has been received.  We definitively determine here if the
     * "Initiate MPU" request has been a success or not.
     *
     * @param id ID associated with the file.
     * @param xhr `XMLHttpRequest` object containing the response, among other things.
     * @param isError A boolean indicating success or failure according to the base ajax requester (primarily based on status code).
     */
    function handleCompleteRequestComplete(id, xhr, isError) {
        var promise = pendingCompleteRequests[id],
            domParser = new DOMParser(),
            endpoint = options.endpointStore.getEndpoint(id),
            bucket = qq.s3.util.getBucket(endpoint),
            key = options.getKey(id),
            responseDoc = domParser.parseFromString(xhr.responseText, "application/xml"),
            bucketEls = responseDoc.getElementsByTagName("Bucket"),
            keyEls = responseDoc.getElementsByTagName("Key");

        delete pendingCompleteRequests[id];

        qq.log(qq.format("Complete response status {}, body = {}", xhr.status, xhr.responseText));

        if (isError) {
            qq.log(qq.format("Complete Multipart Upload request for {} failed with status {}.", id, xhr.status), "error");
        }
        else {
            if (bucketEls.length && keyEls.length) {
                if (bucketEls[0].textContent !== bucket) {
                    isError = true;
                    qq.log(qq.format("Wrong bucket in response to Complete Multipart Upload request for {}.", id), "error");
                }
                if (keyEls[0].textContent !== key) {
                    isError = true;
                    qq.log(qq.format("Wrong key in response to Complete Multipart Upload request for {}.", id), "error");
                }
            }
            else {
                isError = true;
                qq.log(qq.format("Missing bucket and/or key in response to Complete Multipart Upload request for {}.", id), "error");
            }
        }

        if (isError) {
            promise.fail("Problem asking Amazon to combine the parts!");
        }
        else {
            promise.success();
        }
    }

    function getEndOfUrl(id, uploadId) {
        return qq.format("{}?uploadId={}", options.getKey(id), uploadId);
    }

    function getCompleteRequestBody(etagMap) {
        var doc = document.implementation.createDocument(null, "CompleteMultipartUpload", null);

        qq.each(etagMap, function(idx, etagEntry) {
            var part = etagEntry.part,
                etag = etagEntry.etag,
                partEl = doc.createElement("Part"),
                partNumEl = doc.createElement("PartNumber"),
                partNumTextEl = doc.createTextNode(part),
                etagTextEl = doc.createTextNode(etag),
                etagEl = doc.createElement("ETag");

            etagEl.appendChild(etagTextEl);
            partNumEl.appendChild(partNumTextEl);
            partEl.appendChild(partNumEl);
            partEl.appendChild(etagEl);
            qq(doc).children()[0].appendChild(partEl);
        });

        return new XMLSerializer().serializeToString(doc);
    }

    requester = new qq.AjaxRequestor({
        method: getNormalizedMethod(),
        contentType: "application/xml",
        endpointStore: options.endpointStore,
        maxConnections: options.maxConnections,
        log: options.log,
        onComplete: handleCompleteRequestComplete,
        successfulResponseCodes: {
            POST: [200]
        }
    });


    return {
        send: function(id, uploadId, etagMap) {
            var promise = new qq.Promise();

            getHeaders(id, uploadId).then(function(headers) {
                var body = getCompleteRequestBody(etagMap);

                options.log("Submitting S3 complete multipart upload request for " + id);

                pendingCompleteRequests[id] = promise;
                qq.log(body);
                requester.send(id, getEndOfUrl(id, uploadId), null, headers, body);
            }, promise.failure);

            return promise;
        }
    };
};
