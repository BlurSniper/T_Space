﻿// a basic shader to implement temporal resolving

uniform sampler2D inputTexture;
uniform sampler2D accumulatedTexture;
uniform sampler2D velocityTexture;
uniform sampler2D lastVelocityTexture;

uniform float blend;
uniform float correction;
uniform float exponent;
uniform float samples;
uniform vec2 invTexSize;

uniform mat4 curInverseProjectionMatrix;
uniform mat4 curCameraMatrixWorld;
uniform mat4 prevInverseProjectionMatrix;
uniform mat4 prevCameraMatrixWorld;

varying vec2 vUv;

#define MAX_NEIGHBOR_DEPTH_DIFFERENCE 0.001
#define FLOAT_EPSILON                 0.00001
#define FLOAT_NEAR_1                  0.99999

vec3 transformexponent;
vec3 undoColorTransformExponent;

// idea from: https://www.elopezr.com/temporal-aa-and-the-quest-for-the-holy-trail/
vec3 transformColor(vec3 color) {
    if (exponent == 1.0) return color;

    return pow(abs(color), transformexponent);
}

vec3 undoColorTransform(vec3 color) {
    if (exponent == 1.0) return color;

    return max(pow(abs(color), undoColorTransformExponent), vec3(0.0));
}

void main() {
    if (exponent != 1.0) {
        transformexponent = vec3(1.0 / exponent);
        undoColorTransformExponent = vec3(exponent);
    }

    vec4 inputTexel = textureLod(inputTexture, vUv, 0.0);

    vec3 inputColor = transformColor(inputTexel.rgb);
    float alpha = inputTexel.a;

    vec4 accumulatedTexel;
    vec3 accumulatedColor;

    // REPROJECT_START

    float velocityDisocclusion;

#ifdef BOX_BLUR
    vec3 boxBlurredColor = inputTexel.rgb;
#endif

    if (samples < 3.0 || alpha < 1.0) {
        vec3 minNeighborColor = inputColor;
        vec3 maxNeighborColor = inputColor;

        vec3 col;
        vec2 neighborUv;

        vec4 velocity = textureLod(velocityTexture, vUv, 0.0);
        vec2 reprojectedUv = vUv - velocity.xy;
        vec4 lastVelocity = textureLod(lastVelocityTexture, reprojectedUv, 0.0);

        float depth = velocity.b;
        float closestDepth = depth;
        float lastClosestDepth = lastVelocity.b;
        float neighborDepth;
        float lastNeighborDepth;

        const float maxDepthDifference = 0.001;

        for (int x = -correctionRadius; x <= correctionRadius; x++) {
            for (int y = -correctionRadius; y <= correctionRadius; y++) {
                if (x != 0 || y != 0) {
                    neighborUv = vUv + vec2(x, y) * invTexSize;

                    col = textureLod(inputTexture, neighborUv, 0.0).xyz;

#ifdef DILATION
                    if ((x == -1 || x == 1) && (y == -1 || y == 1)) {
                        vec4 neigborVelocity = textureLod(velocityTexture, neighborUv, 0.0);
                        neighborDepth = neigborVelocity.b;

                        if (neighborDepth > closestDepth) {
                            velocity = neigborVelocity;
                            closestDepth = neighborDepth;
                        }

                        vec4 lastNeighborVelocity = textureLod(velocityTexture, vUv + vec2(x, y) * invTexSize, 0.0);
                        lastNeighborDepth = lastNeighborVelocity.b;

                        if (neighborDepth > closestDepth) {
                            lastVelocity = lastNeighborVelocity;
                            lastClosestDepth = lastNeighborDepth;
                        }
                    }
#endif

#ifdef BOX_BLUR
                    // depth-aware box blurring to make new/disoccluded pixels less disrupting
                    if (abs(x) <= 5 && abs(y) <= 5 && abs(depth - neighborDepth) < MAX_NEIGHBOR_DEPTH_DIFFERENCE) {
                        boxBlurredColor += col;
                    }
#endif

                    col = transformColor(col);

                    minNeighborColor = min(col, minNeighborColor);
                    maxNeighborColor = max(col, maxNeighborColor);
                }
            }
        }

        // velocity
        float velocityLength = length(lastVelocity.xy - velocity.xy);

        // using the velocity to find disocclusions
        velocityDisocclusion = (velocityLength - 0.000005) * 10.0;
        velocityDisocclusion *= velocityDisocclusion;

        reprojectedUv = vUv - velocity.xy;

        // box blur

#ifdef BOX_BLUR
        // box blur
        float pxRadius = correctionRadius > 5 ? 121.0 : pow(float(correctionRadius * 2 + 1), 2.0);
        boxBlurredColor /= pxRadius;
        boxBlurredColor = transformColor(boxBlurredColor);
#endif
        // the reprojected UV coordinates are inside the view
        if (reprojectedUv.x >= 0.0 && reprojectedUv.x <= 1.0 && reprojectedUv.y >= 0.0 && reprojectedUv.y <= 1.0) {
            accumulatedTexel = textureLod(accumulatedTexture, reprojectedUv, 0.0);
            accumulatedColor = transformColor(accumulatedTexel.rgb);

            vec3 clampedColor = clamp(accumulatedColor, minNeighborColor, maxNeighborColor);

            accumulatedColor = mix(accumulatedColor, clampedColor, correction);
        } else {
            // reprojected UV coordinates are outside of screen
#ifdef BOX_BLUR
            accumulatedColor = boxBlurredColor;
#else
            accumulatedColor = inputColor;
#endif
        }

        // this texel is marked as constantly moving (e.g. from a VideoTexture), so treat it accordingly
        if (velocity.r > FLOAT_NEAR_1 && velocity.g > FLOAT_NEAR_1) {
            alpha = 0.0;
            velocityDisocclusion = 1.0;
        }
    } else {
        // there was no need to do neighborhood clamping, let's re-use the accumulated texel from the same UV coordinate
        accumulatedColor = transformColor(textureLod(accumulatedTexture, vUv, 0.0).rgb);
    }

    // REPROJECT_END

    vec3 outputColor = inputColor;

    // the user's shader to compose a final outputColor from the inputTexel and accumulatedTexel
#include <custom_compose_shader>

    gl_FragColor = vec4(undoColorTransform(outputColor), alpha);
}