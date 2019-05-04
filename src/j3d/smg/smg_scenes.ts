
import ArrayBufferSlice from 'ArrayBufferSlice';
import Progressable from 'Progressable';
import { assert, nArray, assertExists } from 'util';
import { fetchData } from 'fetch';
import { DeviceProgram } from 'Program';
import * as Viewer from 'viewer';
import { GfxBlendMode, GfxBlendFactor, GfxDevice, GfxRenderPass, GfxHostAccessPass, GfxBindingLayoutDescriptor, GfxSampler, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, GfxRenderPassDescriptor, GfxLoadDisposition, GfxBufferUsage, GfxBufferFrequencyHint } from 'gfx/platform/GfxPlatform';
import { fullscreenMegaState } from 'gfx/helpers/GfxMegaStateDescriptorHelpers';
import { GfxRenderInstViewRenderer, GfxRenderInst, GfxRenderInstBuilder } from 'gfx/render/GfxRenderer';
import { BasicRenderTarget, ColorTexture, standardFullClearRenderPassDescriptor, depthClearRenderPassDescriptor, noClearRenderPassDescriptor, PostFXRenderTarget, ColorAttachment, DepthStencilAttachment, DEFAULT_NUM_SAMPLES, makeEmptyRenderPassDescriptor, copyRenderPassDescriptor } from 'gfx/helpers/RenderTargetHelpers';
import { GfxRenderBuffer } from 'gfx/render/GfxRenderBuffer';
import { fillVec4 } from 'gfx/helpers/UniformBufferHelpers';
import { BMD, BRK, BTK, BCK, LoopMode, BVA, BPK, BTP } from 'j3d/j3d';
import { BMDModel, BMDModelInstance, J3DTextureHolder } from 'j3d/render';
import { mat4, quat, vec3 } from 'gl-matrix';
import * as RARC from 'j3d/rarc';
import { EFB_WIDTH, EFB_HEIGHT, Light } from 'gx/gx_material';
import { GXRenderHelperGfx } from 'gx/gx_render';
import { TextureOverride, TextureMapping } from 'TextureHolder';
import { getPointBezier } from 'Spline';
import AnimationController from 'AnimationController';
import { RENDER_HACKS_ICON } from 'bk/scenes';
import * as Yaz0 from 'compression/Yaz0';
import * as BCSV from 'luigis_mansion/bcsv';
import * as UI from 'ui';
import { TransparentBlack, colorFromRGBA } from 'Color';

// Should I try to do this with GX? lol.
class BloomPassBaseProgram extends DeviceProgram {
    public static BindingsDefinition = `
uniform sampler2D u_Texture;

layout(std140) uniform ub_Params {
    vec4 u_Misc0;
};
#define u_BlurStrength         (u_Misc0.x)
#define u_BokehStrength        (u_Misc0.y)
#define u_BokehCombineStrength (u_Misc0.z)
`;

    public static programReflection = DeviceProgram.parseReflectionDefinitions(BloomPassBaseProgram.BindingsDefinition); 

    public vert: string = `
${BloomPassBaseProgram.BindingsDefinition}

out vec2 v_TexCoord;

void main() {
    vec2 p;
    p.x = (gl_VertexID == 1) ? 2.0 : 0.0;
    p.y = (gl_VertexID == 2) ? 2.0 : 0.0;
    gl_Position.xy = p * vec2(2) - vec2(1);
    gl_Position.zw = vec2(1);
    v_TexCoord = p;
}
`;
}

class BloomPassFullscreenCopyProgram extends BloomPassBaseProgram {
    public frag: string = `
${BloomPassBaseProgram.BindingsDefinition}
    
in vec2 v_TexCoord;

void main() {
    gl_FragColor = texture(u_Texture, v_TexCoord);
}
`;
}

class BloomPassBlurProgram extends BloomPassBaseProgram {
    public frag: string = `
${BloomPassBaseProgram.BindingsDefinition}

in vec2 v_TexCoord;

vec3 TevOverflow(vec3 a) { return fract(a*(255.0/256.0))*(256.0/255.0); }
void main() {
    // Nintendo does this in two separate draws. We combine into one here...
    vec3 c = vec3(0.0);
    // Pass 1.
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00562, -1.0 *  0.00000)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00281, -1.0 * -0.00866)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00281, -1.0 * -0.00866)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00562, -1.0 *  0.00000)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00281, -1.0 *  0.00866)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00281, -1.0 *  0.00866)).rgb * u_BlurStrength);
    // Pass 2.
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00977, -1.0 * -0.00993)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00004, -1.0 * -0.02000)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00972, -1.0 * -0.01006)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00976, -1.0 *  0.00993)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00004, -1.0 *  0.02000)).rgb * u_BlurStrength);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00972, -1.0 *  0.01006)).rgb * u_BlurStrength);
    gl_FragColor = vec4(c.rgb, 1.0);
}
`;
}

class BloomPassBokehProgram extends BloomPassBaseProgram {
    public frag: string = `
${BloomPassBaseProgram.BindingsDefinition}

in vec2 v_TexCoord;

vec3 TevOverflow(vec3 a) { return fract(a*(255.0/256.0))*(256.0/255.0); }
void main() {
    vec3 f = vec3(0.0);
    vec3 c;

    // TODO(jstpierre): Double-check these passes. It seems weighted towards the top left. IS IT THE BLUR???

    // Pass 1.
    c = vec3(0.0);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.02250, -1.0 *  0.00000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.01949, -1.0 * -0.02000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.01125, -1.0 * -0.03464)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00000, -1.0 * -0.04000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.01125, -1.0 * -0.03464)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.01948, -1.0 * -0.02001)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.02250, -1.0 *  0.00000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.01949, -1.0 *  0.02000)).rgb) * u_BokehStrength;
    f += TevOverflow(c);
    // Pass 2.
    c = vec3(0.0);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.01125, -1.0 *  0.03464)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.00000, -1.0 *  0.04000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.01125, -1.0 *  0.03464)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.01948, -1.0 *  0.02001)).rgb) * u_BokehStrength;
    f += TevOverflow(c);
    // Pass 3.
    c = vec3(0.0);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.03937, -1.0 *  0.00000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.03410, -1.0 * -0.03499)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.01970, -1.0 * -0.06061)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00000, -1.0 * -0.07000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.01968, -1.0 * -0.06063)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.03409, -1.0 * -0.03502)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.03937, -1.0 *  0.00000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.03410, -1.0 *  0.03499)).rgb) * u_BokehStrength;
    f += TevOverflow(c);
    // Pass 4.
    c = vec3(0.0);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.01970, -1.0 *  0.06061)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00000, -1.0 *  0.07000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.01968, -1.0 *  0.06063)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.03409, -1.0 *  0.03502)).rgb) * u_BokehStrength;
    f += TevOverflow(c);
    // Pass 5.
    c = vec3(0.0);
    c += (texture(u_Texture, v_TexCoord + vec2(-0.05063, -1.0 *  0.00000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.04385, -1.0 * -0.04499)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.02532, -1.0 * -0.07793)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00000, -1.0 * -0.09000)).rgb) * u_BokehStrength;
    f += TevOverflow(c);
    // Pass 6.
    c = vec3(0.0);
    c += (texture(u_Texture, v_TexCoord + vec2( 0.02532, -1.0 *  0.07793)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2( 0.00000, -1.0 *  0.09000)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.02531, -1.0 *  0.07795)).rgb) * u_BokehStrength;
    c += (texture(u_Texture, v_TexCoord + vec2(-0.04384, -1.0 *  0.04502)).rgb) * u_BokehStrength;
    f += TevOverflow(c);

    f = clamp(f, 0.0, 1.0);

    // Combine pass.
    vec3 g;
    g = (texture(u_Texture, v_TexCoord).rgb * u_BokehCombineStrength);
    g += f * u_BokehCombineStrength;

    gl_FragColor = vec4(g, 1.0);
}
`;
}

const enum SceneGraphTag {
    Skybox = 'Skybox',
    Normal = 'Normal',
    Bloom = 'Bloom',
    Water = 'Water',
    Indirect = 'Indirect',
};

interface ModelMatrixAnimator {
    updateRailAnimation(dst: mat4, time: number): void;
}

class RailAnimationPlatform {
    private railPhase: number = 0;

    constructor(public path: Path, modelMatrix: mat4) {
        assert(path.points.length === 2);
        assert(path.closed === 'OPEN');
        const translation = scratchVec3;
        mat4.getTranslation(translation, modelMatrix);

        // Project translation onto our line segment to find t.
        const seg = vec3.create();
        const prj = vec3.create();
        vec3.sub(seg, path.points[1].p0, path.points[0].p0);
        vec3.sub(prj, translation, path.points[0].p0);
        const n = vec3.dot(prj, seg);
        const d = vec3.dot(seg, seg);
        const t = n / d;
        this.railPhase = t;
    }

    public updateRailAnimation(dst: mat4, time: number): void {
        // TODO(jstpierre): Figure out the path speed.
        const tS = time / 10;
        const t = (tS + this.railPhase) % 1.0;
        interpPathPoints(scratchVec3, this.path.points[0], this.path.points[1], t);
        dst[12] = scratchVec3[0];
        dst[13] = scratchVec3[1];
        dst[14] = scratchVec3[2];
    }
}

class RailAnimationTico {
    private railPhase: number = 0;

    constructor(public path: Path) {
    }

    public updateRailAnimation(dst: mat4, time: number): void {
        const path = this.path;

        // TODO(jstpierre): calculate speed. probably on the objinfo.
        const tS = time / 70;
        const t = (tS + this.railPhase) % 1.0;

        // Which point are we in?
        let numSegments = path.points.length;
        if (path.closed === 'OPEN')
            --numSegments;

        const segmentFrac = t * numSegments;
        const s0 = segmentFrac | 0;
        const sT = segmentFrac - s0;

        const s1 = (s0 >= path.points.length - 1) ? 0 : s0 + 1;
        const pt0 = assertExists(path.points[s0]);
        const pt1 = assertExists(path.points[s1]);

        const c = scratchVec3;
        interpPathPoints(c, pt0, pt1, sT);
        dst[12] = c[0];
        dst[13] = c[1];
        dst[14] = c[2];

        // Now compute the derivative to rotate.
        interpPathPoints(c, pt0, pt1, sT + 0.05);
        c[0] -= dst[12];
        c[1] -= dst[13];
        c[2] -= dst[14];

        const ny = Math.atan2(c[2], -c[0]);
        mat4.rotateY(dst, dst, ny);
    }
}

const scratchVec3 = vec3.create();
class Node {
    public name: string = '';
    public modelMatrix = mat4.create();
    public layer: number = -1;
    public planetRecord: BCSV.BcsvRecord | null = null;

    private modelMatrixAnimator: ModelMatrixAnimator | null = null;
    private rotateSpeed = 0;
    private rotatePhase = 0;
    private rotateAxis = 0;

    constructor(public objinfo: ObjInfo, public modelInstance: BMDModelInstance, parentModelMatrix: mat4, public animationController: AnimationController) {
        this.name = modelInstance.name;
        // BlackHole is special and doesn't inherit SR from parent.
        if (objinfo.objName === 'BlackHole') {
            mat4.copy(this.modelMatrix, objinfo.modelMatrix);
            this.modelMatrix[12] += parentModelMatrix[12];
            this.modelMatrix[13] += parentModelMatrix[13];
            this.modelMatrix[14] += parentModelMatrix[14];
        } else {
            mat4.mul(this.modelMatrix, parentModelMatrix, objinfo.modelMatrix);
        }

        this.setupAnimations();
    }

    public setupAnimations(): void {
        if (this.objinfo.moveConditionType === 0) {
            this.rotateSpeed = this.objinfo.rotateSpeed;
            this.rotateAxis = this.objinfo.rotateAxis;
        }

        const objName = this.objinfo.objName;
        if (objName.startsWith('HoleBeltConveyerParts') && this.objinfo.path) {
            this.modelMatrixAnimator = new RailAnimationPlatform(this.objinfo.path, this.modelMatrix);
        } else if (objName === 'TicoRail') {
            this.modelMatrixAnimator = new RailAnimationTico(this.objinfo.path);
        } else if (objName.endsWith('Coin')) {
            this.rotateSpeed = 140;
            this.rotatePhase = (this.objinfo.modelMatrix[12] + this.objinfo.modelMatrix[13] + this.objinfo.modelMatrix[14]);
            this.rotateAxis = 1;
        }
    }

    public updateMapPartsRotation(dst: mat4, time: number): void {
        if (this.rotateSpeed !== 0) {
            // RotateSpeed appears to be deg/sec?
            const rotateSpeed = this.rotateSpeed / (this.objinfo.rotateAccelType > 0 ? this.objinfo.rotateAccelType : 1);
            const speed = rotateSpeed * Math.PI / 180;
            if (this.rotateAxis === 0)
                mat4.rotateX(dst, dst, (time + this.rotatePhase) * speed);
            else if (this.rotateAxis === 1)
                mat4.rotateY(dst, dst, (time + this.rotatePhase) * speed);
            else if (this.rotateAxis === 2)
                mat4.rotateZ(dst, dst, (time + this.rotatePhase) * speed);
        }
    }

    public updateSpecialAnimations(): void {
        const time = this.animationController.getTimeInSeconds();
        mat4.copy(this.modelInstance.modelMatrix, this.modelMatrix);
        this.updateMapPartsRotation(this.modelInstance.modelMatrix, time);
        if (this.modelMatrixAnimator !== null)
            this.modelMatrixAnimator.updateRailAnimation(this.modelInstance.modelMatrix, time);
    }

    public prepareToRender(renderHelper: GXRenderHelperGfx, viewerInput: Viewer.ViewerRenderInput): void {
        this.updateSpecialAnimations();
        this.modelInstance.prepareToRender(renderHelper, viewerInput);
    }

    public destroy(device: GfxDevice): void {
        this.modelInstance.destroy(device);
    }
}

class SceneGraph {
    public nodes: Node[] = [];
    public onnodeadded: () => void | null = null;

    public addNode(node: Node | null): void {
        if (node === null)
            return;
        this.nodes.push(node);
        const i = this.nodes.length - 1;
        if (this.onnodeadded !== null)
            this.onnodeadded();
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.nodes.length; i++)
            this.nodes[i].destroy(device);
    }
}

function makeFullscreenPassRenderInst(renderInstBuilder: GfxRenderInstBuilder, name: string, program: DeviceProgram): GfxRenderInst {
    const renderInst = renderInstBuilder.pushRenderInst();
    renderInst.drawTriangles(3);
    renderInst.name = name;
    renderInst.setDeviceProgram(program);
    renderInst.inputState = null;
    renderInst.setMegaStateFlags(fullscreenMegaState);
    return renderInst;
}

const TIME_OF_DAY_ICON = `<svg viewBox="0 0 100 100" height="20" fill="white"><path d="M50,93.4C74,93.4,93.4,74,93.4,50C93.4,26,74,6.6,50,6.6C26,6.6,6.6,26,6.6,50C6.6,74,26,93.4,50,93.4z M37.6,22.8  c-0.6,2.4-0.9,5-0.9,7.6c0,18.2,14.7,32.9,32.9,32.9c2.6,0,5.1-0.3,7.6-0.9c-4.7,10.3-15.1,17.4-27.1,17.4  c-16.5,0-29.9-13.4-29.9-29.9C20.3,37.9,27.4,27.5,37.6,22.8z"/></svg>`;

const enum SMGPass {
    SKYBOX = 1 << 0,
    OPAQUE = 1 << 1,
    INDIRECT = 1 << 2,
    BLOOM = 1 << 3,

    BLOOM_DOWNSAMPLE = 1 << 4,
    BLOOM_BLUR = 1 << 5,
    BLOOM_BOKEH = 1 << 6,
    BLOOM_COMBINE = 1 << 7,
}

export class WeirdFancyRenderTarget {
    public colorAttachment = new ColorAttachment();
    private renderPassDescriptor = makeEmptyRenderPassDescriptor();

    constructor(public depthStencilAttachment: DepthStencilAttachment) {
    }

    public setParameters(device: GfxDevice, width: number, height: number, numSamples: number = DEFAULT_NUM_SAMPLES): void {
        this.colorAttachment.setParameters(device, width, height, numSamples);
    }

    public destroy(device: GfxDevice): void {
        this.colorAttachment.destroy(device);
    }

    public createRenderPass(device: GfxDevice, renderPassDescriptor: GfxRenderPassDescriptor): GfxRenderPass {
        copyRenderPassDescriptor(this.renderPassDescriptor, renderPassDescriptor);
        this.renderPassDescriptor.colorAttachment = this.colorAttachment.gfxColorAttachment;
        this.renderPassDescriptor.depthStencilAttachment = this.depthStencilAttachment.gfxDepthStencilAttachment;
        return device.createRenderPass(this.renderPassDescriptor);
    }
}

const bloomClearRenderPassDescriptor: GfxRenderPassDescriptor = {
    colorAttachment: null,
    depthStencilAttachment: null,
    colorClearColor: TransparentBlack,
    colorLoadDisposition: GfxLoadDisposition.CLEAR,
    depthClearValue: 1.0,
    depthLoadDisposition: GfxLoadDisposition.LOAD,
    stencilClearValue: 0.0,
    stencilLoadDisposition: GfxLoadDisposition.LOAD,
};

class SMGRenderer implements Viewer.SceneGfx {
    private sceneGraph: SceneGraph;
    public textureHolder: J3DTextureHolder;

    // Bloom stuff.
    private bloomTemplateRenderInst: GfxRenderInst;
    private bloomParamsBuffer: GfxRenderBuffer;
    private bloomRenderInstDownsample: GfxRenderInst;
    private bloomRenderInstBlur: GfxRenderInst;
    private bloomRenderInstBokeh: GfxRenderInst;
    private bloomRenderInstCombine: GfxRenderInst;
    private bloomSampler: GfxSampler;
    private bloomTextureMapping: TextureMapping[] = nArray(1, () => new TextureMapping());
    private bloomSceneColorTarget: WeirdFancyRenderTarget;
    private bloomSceneColorTexture = new ColorTexture();
    private bloomScratch1ColorTarget = new PostFXRenderTarget();
    private bloomScratch1ColorTexture = new ColorTexture();
    private bloomScratch2ColorTarget = new PostFXRenderTarget();
    private bloomScratch2ColorTexture = new ColorTexture();

    private mainRenderTarget = new BasicRenderTarget();
    private opaqueSceneTexture = new ColorTexture();
    private currentScenarioIndex: number = 0;
    private scenarioSelect: UI.SingleSelect;

    public onstatechanged!: () => void;

    constructor(device: GfxDevice, private spawner: SMGSpawner, private viewRenderer: GfxRenderInstViewRenderer, private scenarioData: BCSV.Bcsv, private zoneNames: string[]) {
        this.sceneGraph = spawner.sceneGraph;
        this.textureHolder = spawner.textureHolder;

        this.sceneGraph.onnodeadded = () => {
            this.applyCurrentScenario();
        };

        this.bloomSampler = device.createSampler({
            wrapS: GfxWrapMode.CLAMP,
            wrapT: GfxWrapMode.CLAMP,
            minFilter: GfxTexFilterMode.BILINEAR,
            magFilter: GfxTexFilterMode.BILINEAR,
            mipFilter: GfxMipFilterMode.NO_MIP,
            minLOD: 0,
            maxLOD: 100,
        });
        this.bloomTextureMapping[0].gfxSampler = this.bloomSampler;

        const bindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 1 }];
        this.bloomParamsBuffer = new GfxRenderBuffer(GfxBufferUsage.UNIFORM, GfxBufferFrequencyHint.DYNAMIC, `ub_Params`);
        const renderInstBuilder = new GfxRenderInstBuilder(device, BloomPassBaseProgram.programReflection, bindingLayouts, [this.bloomParamsBuffer]);

        this.bloomTemplateRenderInst = renderInstBuilder.pushTemplateRenderInst();
        renderInstBuilder.newUniformBufferInstance(this.bloomTemplateRenderInst, 0);
        this.bloomSceneColorTarget = new WeirdFancyRenderTarget(this.mainRenderTarget.depthStencilAttachment);
        this.bloomRenderInstDownsample = makeFullscreenPassRenderInst(renderInstBuilder, 'bloom downsample', new BloomPassFullscreenCopyProgram());
        this.bloomRenderInstDownsample.passMask = SMGPass.BLOOM_DOWNSAMPLE;

        this.bloomRenderInstBlur = makeFullscreenPassRenderInst(renderInstBuilder, 'bloom blur', new BloomPassBlurProgram());
        this.bloomRenderInstBlur.passMask = SMGPass.BLOOM_BLUR;

        this.bloomRenderInstBokeh = makeFullscreenPassRenderInst(renderInstBuilder, 'bloom bokeh', new BloomPassBokehProgram());
        this.bloomRenderInstBokeh.passMask = SMGPass.BLOOM_BOKEH;

        this.bloomRenderInstCombine = makeFullscreenPassRenderInst(renderInstBuilder, 'bloom combine', new BloomPassFullscreenCopyProgram());
        this.bloomRenderInstCombine.passMask = SMGPass.BLOOM_COMBINE;
        this.bloomRenderInstCombine.setMegaStateFlags({
            blendMode: GfxBlendMode.ADD,
            blendSrcFactor: GfxBlendFactor.ONE,
            blendDstFactor: GfxBlendFactor.ONE,
        });

        renderInstBuilder.popTemplateRenderInst();
        renderInstBuilder.finish(device, this.viewRenderer);
    }

    private applyCurrentScenario(): void {
        const scenarioRecord = this.scenarioData.records[this.currentScenarioIndex];

        for (let i = 0; i < this.spawner.zones.length; i++) {
            const zoneNode = this.spawner.zones[i];
            zoneNode.layerMask = BCSV.getField<number>(this.scenarioData, scenarioRecord, zoneNode.zone.name, 0);
        }

        this.spawner.zones[0].computeObjectVisibility();
    }

    public setCurrentScenario(index: number): void {
        if (this.currentScenarioIndex === index)
            return;

        this.currentScenarioIndex = index;
        this.scenarioSelect.setHighlighted(this.currentScenarioIndex);
        this.onstatechanged();
        this.applyCurrentScenario();
    }

    public createPanels(): UI.Panel[] {
        const scenarioPanel = new UI.Panel();
        scenarioPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        scenarioPanel.setTitle(TIME_OF_DAY_ICON, 'Scenario');

        const scenarioNames = this.scenarioData.records.map((record) => {
            return BCSV.getField<string>(this.scenarioData, record, 'ScenarioName');
        });
        this.scenarioSelect = new UI.SingleSelect();
        this.scenarioSelect.setStrings(scenarioNames);
        this.scenarioSelect.onselectionchange = (index: number) => {
            this.setCurrentScenario(index);
        };
        this.scenarioSelect.selectItem(0);

        scenarioPanel.contents.appendChild(this.scenarioSelect.elem);

        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(RENDER_HACKS_ICON, 'Render Hacks');
        const enableVertexColorsCheckbox = new UI.Checkbox('Enable Vertex Colors', true);
        enableVertexColorsCheckbox.onchanged = () => {
            for (let i = 0; i < this.sceneGraph.nodes.length; i++)
                this.sceneGraph.nodes[i].modelInstance.setVertexColorsEnabled(enableVertexColorsCheckbox.checked);
        };
        renderHacksPanel.contents.appendChild(enableVertexColorsCheckbox.elem);
        const enableTextures = new UI.Checkbox('Enable Textures', true);
        enableTextures.onchanged = () => {
            for (let i = 0; i < this.sceneGraph.nodes.length; i++)
                this.sceneGraph.nodes[i].modelInstance.setTexturesEnabled(enableTextures.checked);
        };
        renderHacksPanel.contents.appendChild(enableTextures.elem);

        return [scenarioPanel, renderHacksPanel];
    }

    private prepareToRenderBloom(hostAccessPass: GfxHostAccessPass): void {
        let offs = this.bloomTemplateRenderInst.getUniformBufferOffset(0);
        const d = this.bloomParamsBuffer.mapBufferF32(offs, 4);
        // TODO(jstpierre): Dynamically adjust based on Area.
        if (this.spawner.zones[0].zone.name === 'PeachCastleGardenGalaxy')
            fillVec4(d, offs, 40/256, 60/256, 110/256);
        else
            fillVec4(d, offs, 25/256, 25/256, 50/256);
        this.bloomParamsBuffer.prepareToRender(hostAccessPass);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();

        this.prepareToRenderBloom(hostAccessPass);

        this.spawner.prepareToRender(hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);
        this.mainRenderTarget.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.opaqueSceneTexture.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.viewRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);

        this.viewRenderer.prepareToRender(device);

        const skyboxPassRenderer = this.mainRenderTarget.createRenderPass(device, standardFullClearRenderPassDescriptor);
        this.viewRenderer.executeOnPass(device, skyboxPassRenderer, SMGPass.SKYBOX);
        skyboxPassRenderer.endPass(null);
        device.submitPass(skyboxPassRenderer);

        const opaquePassRenderer = this.mainRenderTarget.createRenderPass(device, depthClearRenderPassDescriptor);
        this.viewRenderer.executeOnPass(device, opaquePassRenderer, SMGPass.OPAQUE);

        let lastPassRenderer: GfxRenderPass;
        if (this.viewRenderer.hasAnyVisible(SMGPass.INDIRECT)) {
            opaquePassRenderer.endPass(this.opaqueSceneTexture.gfxTexture);
            device.submitPass(opaquePassRenderer);

            const textureOverride: TextureOverride = { gfxTexture: this.opaqueSceneTexture.gfxTexture, width: EFB_WIDTH, height: EFB_HEIGHT, flipY: true };
            this.textureHolder.setTextureOverride("IndDummy", textureOverride);

            const indTexPassRenderer = this.mainRenderTarget.createRenderPass(device, noClearRenderPassDescriptor);
            this.viewRenderer.executeOnPass(device, indTexPassRenderer, SMGPass.INDIRECT);
            lastPassRenderer = indTexPassRenderer;
        } else {
            lastPassRenderer = opaquePassRenderer;
        }

        if (this.viewRenderer.hasAnyVisible(SMGPass.BLOOM)) {
            lastPassRenderer.endPass(null);
            device.submitPass(lastPassRenderer);

            const bloomColorTargetScene = this.bloomSceneColorTarget;
            const bloomColorTextureScene = this.bloomSceneColorTexture;
            bloomColorTargetScene.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
            bloomColorTextureScene.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
            const bloomPassRenderer = bloomColorTargetScene.createRenderPass(device, bloomClearRenderPassDescriptor);
            this.viewRenderer.executeOnPass(device, bloomPassRenderer, SMGPass.BLOOM);
            bloomPassRenderer.endPass(bloomColorTextureScene.gfxTexture);
            device.submitPass(bloomPassRenderer);

            // Downsample.
            const bloomWidth = viewerInput.viewportWidth >> 2;
            const bloomHeight = viewerInput.viewportHeight >> 2;
            this.viewRenderer.setViewport(bloomWidth, bloomHeight);

            const bloomColorTargetDownsample = this.bloomScratch1ColorTarget;
            const bloomColorTextureDownsample = this.bloomScratch1ColorTexture;
            bloomColorTargetDownsample.setParameters(device, bloomWidth, bloomHeight, 1);
            bloomColorTextureDownsample.setParameters(device, bloomWidth, bloomHeight);
            this.bloomTextureMapping[0].gfxTexture = bloomColorTextureScene.gfxTexture;
            this.bloomRenderInstDownsample.setSamplerBindingsFromTextureMappings(this.bloomTextureMapping);
            const bloomDownsamplePassRenderer = bloomColorTargetDownsample.createRenderPass(device, noClearRenderPassDescriptor);
            this.viewRenderer.executeOnPass(device, bloomDownsamplePassRenderer, SMGPass.BLOOM_DOWNSAMPLE);
            bloomDownsamplePassRenderer.endPass(bloomColorTextureDownsample.gfxTexture);
            device.submitPass(bloomDownsamplePassRenderer);

            // Blur.
            const bloomColorTargetBlur = this.bloomScratch2ColorTarget;
            const bloomColorTextureBlur = this.bloomScratch2ColorTexture;
            bloomColorTargetBlur.setParameters(device, bloomWidth, bloomHeight, 1);
            bloomColorTextureBlur.setParameters(device, bloomWidth, bloomHeight);
            this.bloomTextureMapping[0].gfxTexture = bloomColorTextureDownsample.gfxTexture;
            this.bloomRenderInstBlur.setSamplerBindingsFromTextureMappings(this.bloomTextureMapping);
            const bloomBlurPassRenderer = bloomColorTargetBlur.createRenderPass(device, noClearRenderPassDescriptor);
            this.viewRenderer.executeOnPass(device, bloomBlurPassRenderer, SMGPass.BLOOM_BLUR);
            bloomBlurPassRenderer.endPass(bloomColorTextureBlur.gfxTexture);
            device.submitPass(bloomBlurPassRenderer);

            // TODO(jstpierre): Downsample blur / bokeh as well.

            // Bokeh-ify.
            // We can ditch the second render target now, so just reuse it.
            const bloomColorTargetBokeh = this.bloomScratch1ColorTarget;
            const bloomColorTextureBokeh = this.bloomScratch1ColorTexture;
            const bloomBokehPassRenderer = bloomColorTargetBokeh.createRenderPass(device, noClearRenderPassDescriptor);
            this.bloomTextureMapping[0].gfxTexture = bloomColorTextureBlur.gfxTexture;
            this.bloomRenderInstBokeh.setSamplerBindingsFromTextureMappings(this.bloomTextureMapping);
            this.viewRenderer.executeOnPass(device, bloomBokehPassRenderer, SMGPass.BLOOM_BOKEH);
            bloomBokehPassRenderer.endPass(bloomColorTextureBokeh.gfxTexture);
            device.submitPass(bloomBokehPassRenderer);

            // Combine.
            const bloomCombinePassRenderer = this.mainRenderTarget.createRenderPass(device, noClearRenderPassDescriptor);
            this.bloomTextureMapping[0].gfxTexture = bloomColorTextureBokeh.gfxTexture;
            this.bloomRenderInstCombine.setSamplerBindingsFromTextureMappings(this.bloomTextureMapping);
            this.viewRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);
            this.viewRenderer.executeOnPass(device, bloomCombinePassRenderer, SMGPass.BLOOM_COMBINE);
            lastPassRenderer = bloomCombinePassRenderer;
        }

        return lastPassRenderer;
    }

    public serializeSaveState(dst: ArrayBuffer, offs: number): number {
        const view = new DataView(dst);
        view.setUint8(offs++, this.currentScenarioIndex);
        return offs;
    }

    public deserializeSaveState(dst: ArrayBuffer, offs: number, byteLength: number): number {
        const view = new DataView(dst);
        if (offs < byteLength)
            this.setCurrentScenario(view.getUint8(offs++));
        return offs;
    }

    public destroy(device: GfxDevice): void {
        this.spawner.destroy(device);

        this.mainRenderTarget.destroy(device);
        this.opaqueSceneTexture.destroy(device);

        this.bloomParamsBuffer.destroy(device);
        device.destroyProgram(this.bloomRenderInstBlur.gfxProgram);
        device.destroyProgram(this.bloomRenderInstBokeh.gfxProgram);
        device.destroyProgram(this.bloomRenderInstCombine.gfxProgram);
        device.destroyProgram(this.bloomRenderInstDownsample.gfxProgram);

        device.destroySampler(this.bloomSampler);
        this.bloomSceneColorTarget.destroy(device);
        this.bloomSceneColorTexture.destroy(device);
        this.bloomScratch1ColorTarget.destroy(device);
        this.bloomScratch1ColorTexture.destroy(device);
        this.bloomScratch2ColorTarget.destroy(device);
        this.bloomScratch2ColorTexture.destroy(device);
    }
}

function getLayerName(index: number) {
    if (index === -1) {
        return 'common';
    } else {
        assert(index >= 0);
        const char = String.fromCharCode('a'.charCodeAt(0) + index);
        return `layer${char}`;
    }
}

interface Point {
    p0: vec3;
    p1: vec3;
    p2: vec3;
}

interface Path {
    l_id: number;
    name: string;
    type: string;
    closed: string;
    points: Point[];
}

interface ObjInfo {
    objId: number;
    objName: string;
    objArg0: number;
    objArg1: number;
    objArg2: number;
    objArg3: number;
    moveConditionType: number;
    rotateSpeed: number;
    rotateAxis: number;
    rotateAccelType: number;
    modelMatrix: mat4;
    path: Path;
}

interface ZoneLayer {
    index: number;
    objinfo: ObjInfo[];
    mappartsinfo: ObjInfo[];
    stageobjinfo: ObjInfo[];
}

interface Zone {
    name: string;
    layers: ZoneLayer[];
}

function computeModelMatrixFromRecord(modelMatrix: mat4, bcsv: BCSV.Bcsv, record: BCSV.BcsvRecord): void {
    const pos_x = BCSV.getField<number>(bcsv, record, 'pos_x', 0);
    const pos_y = BCSV.getField<number>(bcsv, record, 'pos_y', 0);
    const pos_z = BCSV.getField<number>(bcsv, record, 'pos_z', 0);
    const dir_x = BCSV.getField<number>(bcsv, record, 'dir_x', 0);
    const dir_y = BCSV.getField<number>(bcsv, record, 'dir_y', 0);
    const dir_z = BCSV.getField<number>(bcsv, record, 'dir_z', 0);
    const scale_x = BCSV.getField<number>(bcsv, record, 'scale_x', 1);
    const scale_y = BCSV.getField<number>(bcsv, record, 'scale_y', 1);
    const scale_z = BCSV.getField<number>(bcsv, record, 'scale_z', 1);
    const q = quat.create();
    quat.fromEuler(q, dir_x, dir_y, dir_z);
    mat4.fromRotationTranslationScale(modelMatrix, q, [pos_x, pos_y, pos_z], [scale_x, scale_y, scale_z]);
}

interface AnimOptions {
    bck?: string;
    btk?: string;
    brk?: string;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function getPointLinear_3(dst: vec3, p0: vec3, p1: vec3, t: number): void {
    dst[0] = lerp(p0[0], p1[0], t);
    dst[1] = lerp(p0[1], p1[1], t);
    dst[2] = lerp(p0[2], p1[2], t);
}

function getPointBezier_3(dst: vec3, p0: vec3, c0: vec3, c1: vec3, p1: vec3, t: number): void {
    dst[0] = getPointBezier(p0[0], c0[0], c1[0], p1[0], t);
    dst[1] = getPointBezier(p0[1], c0[1], c1[1], p1[1], t);
    dst[2] = getPointBezier(p0[2], c0[2], c1[2], p1[2], t);
}

function interpPathPoints(dst: vec3, pt0: Point, pt1: Point, t: number): void {
    const p0 = pt0.p0;
    const c0 = pt0.p2;
    const c1 = pt1.p1;
    const p1 = pt1.p0;
    if (vec3.equals(p0, c0) && vec3.equals(c1, p1))
        getPointLinear_3(dst, p0, p1, t);
    else
        getPointBezier_3(dst, p0, c0, c1, p1, t);
}

class ModelCache {
    public promiseCache = new Map<string, Progressable<BMDModel>>();
    public archiveCache = new Map<string, RARC.RARC>();
    private models: BMDModel[] = [];
    private destroyed: boolean = false;

    public getModel(device: GfxDevice, renderHelper: GXRenderHelperGfx, textureHolder: J3DTextureHolder, archivePath: string, modelFilename: string): Progressable<BMDModel> {
        if (this.promiseCache.has(archivePath))
            return this.promiseCache.get(archivePath);

        const p = fetchData(archivePath).then((buffer: ArrayBufferSlice) => {
            if (buffer.byteLength === 0) {
                console.warn(`Could not fetch archive ${archivePath}`);
                return null;
            }
            return Yaz0.decompress(buffer);
        }).then((buffer: ArrayBufferSlice) => {
            if (buffer === null)
                return null;
            if (this.destroyed)
                return null;
            const rarc = RARC.parse(buffer);
            const bmd = BMD.parse(assertExists(rarc.findFileData(modelFilename)));
            const bmdModel = new BMDModel(device, renderHelper, bmd, null);
            textureHolder.addJ3DTextures(device, bmd);
            this.archiveCache.set(archivePath, rarc);
            this.models.push(bmdModel);
            return bmdModel;
        });

        this.promiseCache.set(archivePath, p);
        return p;
    }

    public destroy(device: GfxDevice): void {
        this.destroyed = true;
        for (let i = 0; i < this.models.length; i++)
            this.models[i].destroy(device);
    }
}

function layerVisible(layer: number, layerMask: number): boolean {
    if (layer >= 0)
        return !!(layerMask & (1 << layer));
    else
        return true;
}

class ZoneNode {
    public objects: Node[] = [];

    // The current layer mask for objects and sub-zones in this zone.
    public layerMask: number = 0xFFFFFFFF;
    // Whether the layer of our parent zone is visible.
    public visible: boolean = true;
    public subzones: ZoneNode[] = [];

    constructor(public zone: Zone, private layer: number = -1) {
    }

    public computeObjectVisibility(): void {
        for (let i = 0; i < this.objects.length; i++)
            this.objects[i].modelInstance.setVisible(this.visible && layerVisible(this.objects[i].layer, this.layerMask));

        for (let i = 0; i < this.subzones.length; i++) {
            this.subzones[i].visible = this.visible && layerVisible(this.subzones[i].layer, this.layerMask);
            this.subzones[i].computeObjectVisibility();
        }
    }
}

function lightSetFromLightDataRecord(light: Light, bcsv: BCSV.Bcsv, record: BCSV.BcsvRecord, prefix: string): void {
    const colorR = BCSV.getField(bcsv, record, `${prefix}ColorR`, 0) / 0xFF;
    const colorG = BCSV.getField(bcsv, record, `${prefix}ColorG`, 0) / 0xFF;
    const colorB = BCSV.getField(bcsv, record, `${prefix}ColorB`, 0) / 0xFF;
    const colorA = BCSV.getField(bcsv, record, `${prefix}ColorA`, 0) / 0xFF;
    colorFromRGBA(light.Color, colorR, colorG, colorB, colorA);

    const posX = BCSV.getField(bcsv, record, `${prefix}PosX`, 0);
    const posY = BCSV.getField(bcsv, record, `${prefix}PosY`, 0);
    const posZ = BCSV.getField(bcsv, record, `${prefix}PosZ`, 0);
    vec3.set(light.Position, posX, posY, posZ);

    vec3.set(light.Direction, 1, 0, 0);
    vec3.set(light.CosAtten, 1, 0, 0);
    vec3.set(light.DistAtten, 1, 0, 0);
}

class SMGSpawner {
    public textureHolder = new J3DTextureHolder();
    public sceneGraph = new SceneGraph();
    public zones: ZoneNode[] = [];
    private modelCache = new ModelCache();
    // BackLight
    private backlight = new Light();
    private isSMG1 = false;
    private isSMG2 = false;

    constructor(private pathBase: string, private renderHelper: GXRenderHelperGfx, private viewRenderer: GfxRenderInstViewRenderer, private planetTable: BCSV.Bcsv, private lightData: BCSV.Bcsv) {
        this.isSMG1 = this.pathBase === 'j3d/smg';
        this.isSMG2 = this.pathBase === 'j3d/smg2';

        // "Rim" backlight settings.
        colorFromRGBA(this.backlight.Color, 0, 0, 0, 0.5);
        vec3.set(this.backlight.CosAtten, 1, 0, 0);
        vec3.set(this.backlight.DistAtten, 1, 0, 0);
        vec3.set(this.backlight.Position, 0, 0, 0);
        vec3.set(this.backlight.Direction, 0, -1, 0);
    }

    public prepareToRender(hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        viewerInput.camera.setClipPlanes(20, 500000);
        this.renderHelper.fillSceneParams(viewerInput);
        for (let i = 0; i < this.sceneGraph.nodes.length; i++)
            this.sceneGraph.nodes[i].prepareToRender(this.renderHelper, viewerInput);
        this.renderHelper.prepareToRender(hostAccessPass);
    }

    public applyAnimations(node: Node, rarc: RARC.RARC, animOptions?: AnimOptions): void {
        const modelInstance = node.modelInstance;

        let bckFile: RARC.RARCFile | null = null;
        let brkFile: RARC.RARCFile | null = null;
        let btkFile: RARC.RARCFile | null = null;

        if (animOptions !== null) {
            if (animOptions !== undefined) {
                bckFile = animOptions.bck ? rarc.findFile(animOptions.bck) : null;
                brkFile = animOptions.brk ? rarc.findFile(animOptions.brk) : null;
                btkFile = animOptions.btk ? rarc.findFile(animOptions.btk) : null;
            } else {
                // Look for "wait" animation first, then fall back to the first animation.
                bckFile = rarc.findFile('wait.bck');
                brkFile = rarc.findFile('wait.brk');
                btkFile = rarc.findFile('wait.btk');
                if (!(bckFile || brkFile || btkFile)) {
                    bckFile = rarc.files.find((file) => file.name.endsWith('.bck')) || null;
                    brkFile = rarc.files.find((file) => file.name.endsWith('.brk') && file.name.toLowerCase() !== 'colorchange.brk') || null;
                    btkFile = rarc.files.find((file) => file.name.endsWith('.btk') && file.name.toLowerCase() !== 'texchange.btk') || null;
                }
            }
        }

        if (btkFile !== null) {
            const btk = BTK.parse(btkFile.buffer);
            modelInstance.bindTTK1(btk.ttk1);
        }

        if (brkFile !== null) {
            const brk = BRK.parse(brkFile.buffer);
            modelInstance.bindTRK1(brk.trk1);
        }

        if (bckFile !== null) {
            const bck = BCK.parse(bckFile.buffer);
            // XXX(jstpierre): Some wait.bck animations are set to ONCE instead of REPEAT (e.g. Kinopio/Toad in SMG2)
            if (bckFile.name === 'wait.bck')
                bck.ank1.loopMode = LoopMode.REPEAT;
            modelInstance.bindANK1(bck.ank1);

            // Apply a random phase to the animation.
            modelInstance.animationController.phaseFrames += Math.random() * bck.ank1.duration;
        }
    }

    public bindChangeAnimation(node: Node, rarc: RARC.RARC, frame: number): void {
        const brkFile = rarc.findFile('colorchange.brk');
        const btkFile = rarc.findFile('texchange.btk');

        const animationController = new AnimationController();
        animationController.setTimeInFrames(frame);

        if (brkFile) {
            const brk = BRK.parse(brkFile.buffer);
            node.modelInstance.bindTRK1(brk.trk1, animationController);
        }

        if (btkFile) {
            const btk = BTK.parse(btkFile.buffer);
            node.modelInstance.bindTTK1(btk.ttk1, animationController);
        }
    }

    private hasIndirectTexture(bmdModel: BMDModel): boolean {
        const tex1Samplers = bmdModel.bmd.tex1.samplers;
        for (let i = 0; i < tex1Samplers.length; i++)
            if (tex1Samplers[i].name === 'IndDummy')
                return true;
        return false;
    }

    private nodeSetLightName(node: Node, lightName: string): void {
        // TODO(jstpierre): Parse areas, gather proper lights through that system.
        const light = this.lightData.records.find((record) => BCSV.getField<string>(this.lightData, record, 'AreaLightName', '') === lightName);

        const light0 = node.modelInstance.getGXLightReference(0);
        const light1 = node.modelInstance.getGXLightReference(1);
        if (node.planetRecord !== null) {
            lightSetFromLightDataRecord(light0, this.lightData, light, `PlanetLight0`);
            lightSetFromLightDataRecord(light1, this.lightData, light, `PlanetLight1`);
        } else {
            lightSetFromLightDataRecord(light0, this.lightData, light, `StrongLight0`);
            lightSetFromLightDataRecord(light1, this.lightData, light, `StrongLight1`);
        }
    }

    public spawnObject(device: GfxDevice, zone: ZoneNode, layer: number, objinfo: ObjInfo, modelMatrixBase: mat4): void {
        const spawnGraph = (arcName: string, tag: SceneGraphTag = SceneGraphTag.Normal, animOptions: AnimOptions | null | undefined = undefined, planetRecord: BCSV.BcsvRecord | null = null) => {
            const arcPath = `${this.pathBase}/ObjectData/${arcName}.arc`;
            const modelFilename = `${arcName}.bdl`;
            return this.modelCache.getModel(device, this.renderHelper, this.textureHolder, arcPath, modelFilename).then((bmdModel): [Node, RARC.RARC] | null => {
                if (bmdModel === null)
                    return null;

                if (this.hasIndirectTexture(bmdModel))
                    tag = SceneGraphTag.Indirect;

                // Trickery.
                const rarc = this.modelCache.archiveCache.get(arcPath);

                const modelInstance = new BMDModelInstance(device, this.renderHelper, this.textureHolder, bmdModel);
                modelInstance.name = `${objinfo.objName} ${objinfo.objId}`;

                if (tag === SceneGraphTag.Skybox) {
                    mat4.scale(objinfo.modelMatrix, objinfo.modelMatrix, [.5, .5, .5]);

                    // Kill translation. Need to figure out how the game does skyboxes.
                    objinfo.modelMatrix[12] = 0;
                    objinfo.modelMatrix[13] = 0;
                    objinfo.modelMatrix[14] = 0;

                    modelInstance.isSkybox = true;
                    modelInstance.passMask = SMGPass.SKYBOX;
                } else if (tag === SceneGraphTag.Indirect) {
                    modelInstance.passMask = SMGPass.INDIRECT;
                } else if (tag === SceneGraphTag.Bloom) {
                    modelInstance.passMask = SMGPass.BLOOM;
                } else {
                    modelInstance.passMask = SMGPass.OPAQUE;
                }

                const node = new Node(objinfo, modelInstance, modelMatrixBase, modelInstance.animationController);
                node.layer = layer;
                zone.objects.push(node);

                // TODO(jstpierre):
                const lightName = '[共通]昼（どら焼き）';
                this.nodeSetLightName(node, lightName);
                modelInstance.setGXLight(2, this.backlight);

                this.applyAnimations(node, rarc, animOptions);

                this.sceneGraph.addNode(node);

                this.renderHelper.renderInstBuilder.constructRenderInsts(device, this.viewRenderer);
                return [node, rarc];
            });
        };

        const spawnDefault = (name: string): void => {
            // Spawn planets.
            const planetRecord = this.planetTable.records.find((record) => BCSV.getField(this.planetTable, record, 'PlanetName') === name);
            if (planetRecord) {
                spawnGraph(name, SceneGraphTag.Normal, undefined, planetRecord);

                const bloomFlag = BCSV.getField(this.planetTable, planetRecord, 'BloomFlag');
                const waterFlag = BCSV.getField(this.planetTable, planetRecord, 'WaterFlag');
                const indirectFlag = BCSV.getField(this.planetTable, planetRecord, 'IndirectFlag');
                if (bloomFlag)
                    spawnGraph(`${name}Bloom`, SceneGraphTag.Bloom, undefined, planetRecord);
                if (waterFlag)
                    spawnGraph(`${name}Water`, SceneGraphTag.Water, undefined, planetRecord);
                if (indirectFlag)
                    spawnGraph(`${name}Indirect`, SceneGraphTag.Indirect, undefined, planetRecord);
            } else {
                spawnGraph(name, SceneGraphTag.Normal);
            }
        };

        function animFrame(frame: number) {
            const animationController = new AnimationController();
            animationController.setTimeInFrames(frame);
            return animationController;
        }

        const name = objinfo.objName;
        switch (objinfo.objName) {

            // Skyboxen.
        case 'AuroraSky':
        case 'BeyondGalaxySky':
        case 'BeyondHellValleySky':
        case 'BeyondHorizonSky':
        case 'BeyondOrbitSky':
        case 'BeyondPhantomSky':
        case 'BeyondSandSky':
        case 'BeyondSandNightSky':
        case 'BeyondSummerSky':
        case 'BeyondTitleSky':
        case 'BigFallSky':
        case 'Blue2DSky':
        case 'BrightGalaxySky':
        case 'ChildRoomSky':
        case 'CloudSky':
        case 'DarkSpaceStormSky':
        case 'DesertSky':
        case 'DotPatternSky':
        case 'FamicomMarioSky':
        case 'GalaxySky':
        case 'GoodWeatherSky':
        case 'GreenPlanetOrbitSky':
        case 'HalfGalaxySky':
        case 'HolePlanetInsideSky':
        case 'KoopaVS1Sky':
        case 'KoopaVS2Sky':
        case 'KoopaJrLv3Sky':
        case 'MagmaMonsterSky':
        case 'MemoryRoadSky':
        case 'MilkyWaySky':
        case 'OmoteuLandSky':
        case 'PhantomSky':
        case 'RockPlanetOrbitSky':
        case 'SummerSky':
        case 'VRDarkSpace':
        case 'VROrbit':
        case 'VRSandwichSun':
        case 'VsKoopaLv3Sky':
            spawnGraph(name, SceneGraphTag.Skybox);
            break;

        case 'PeachCastleTownAfterAttack':
            // Don't show. We want the pristine town state.
            return;

        case 'ElectricRail':
            // Covers the path with the rail -- will require special spawn logic.
            return;

        case 'FlowerGroup':
        case 'FlowerBlueGroup':
        case 'ShootingStar':
        case 'MeteorCannon':
        case 'Plant':
        case 'WaterPlant':
        case 'SwingRope':
        case 'Creeper':
        case 'TrampleStar':
        case 'Flag':
        case 'FlagPeachCastleA':
        case 'FlagPeachCastleB':
        case 'FlagPeachCastleC':
        case 'FlagKoopaA':
        case 'FlagKoopaB':
        case 'FlagKoopaC':
        case 'FlagKoopaCastle':
        case 'FlagRaceA':
        case 'FlagRaceB':
        case 'FlagRaceC':
        case 'FlagTamakoro':
        case 'OceanRing':
        case 'WoodLogBridge':
        case 'SandBird':
        case 'RingBeamerAreaObj':
        case 'StatusFloor':
            // Archives just contain the textures. Mesh geometry appears to be generated at runtime by the game.
            return;

        case 'InvisibleWall10x10':
        case 'InvisibleWall10x20':
        case 'InvisibleWallJump10x20':
        case 'InvisibleWallGCapture10x20':
        case 'InvisibleWaterfallTwinFallLake':
        case 'GhostShipCavePipeCollision':
            // Invisible / Collision only.
            return;

        case 'LavaMiniSunPlanet':
            // XXX(jstpierre): This has a texture named LavaSun which will corrupt the texture holder, so just
            // prevent it spawning for now.
            return;

        case 'TimerSwitch':
        case 'ClipFieldSwitch':
        case 'SoundSyncSwitch':
        case 'ExterminationSwitch':
        case 'SwitchSynchronizerReverse':
        case 'PrologueDirector':
        case 'MovieStarter':
        case 'ScenarioStarter':
        case 'LuigiEvent':
        case 'MameMuimuiScorer':
        case 'MameMuimuiScorerLv2':
        case 'ScoreAttackCounter':
        case 'RepeartTimerSwitch':
        case 'FlipPanelObserver':
            // Logic objects.
            return;

        case 'OpeningDemoObj':
        case 'NormalEndingDemoObj':
        case 'MeetKoopaDemoObj':
            // Cutscenes.
            return;

        case 'StarPieceFollowGroup':
        case 'StarPieceGroup':
        case 'StarPieceSpot':
        case 'StarPieceFlow':
        case 'WingBlockStarPiece':
        case 'YellowChipGroup':
        case 'RailCoin':
        case 'PurpleRailCoin':
        case 'CircleCoinGroup':
        case 'CirclePurpleCoinGroup':
        case 'PurpleCoinCompleteWatcher':
        case 'CoinAppearSpot':
        case 'GroupSwitchWatcher':
        case 'ExterminationPowerStar':
        case 'LuigiIntrusively':
        case 'MameMuimuiAttackMan':
        case 'CutBushGroup':
        case 'SuperDreamer':
        case 'PetitPorterWarpPoint':
        case 'SimpleDemoExecutor':
        case 'TimerCoinBlock':
        case 'CoinLinkGroup':
        case 'CollectTico':
        case 'BrightSun':
        case 'SplashPieceBlock':
        case 'LavaSparksS':
        case 'InstantInferno':
        case 'BlackHoleCube':
        case 'FireRing':
        case 'FireBar':
        case 'JumpBeamer':
        case 'WaterFortressRain':
        case 'BringEnemy':
        case 'IceLayerBreak':
        case 'HeadLight':
        case 'TereboGroup':
        case 'NoteFairy':
        case 'Tongari2D':
        case 'Grapyon':
        case 'ExterminationCheckerWoodBox':
        case 'GliderShooter':
        case 'CaveInCube':
        case 'RaceRail':
        case 'GliBirdNpc':
        case 'SecretGateCounter':
        case 'PhantomTorch':
        case 'HammerHeadPackun':
        case 'Hanachan':
        case 'MarinePlant':
        case 'ForestWaterfallS':
        case 'Nyoropon':
        case 'WaterStream':
        case 'BallRail':
        case 'SphereRailDash':
        case 'HammerHeadPackunSpike':
            // No archives. Needs R&D for what to display.
            return;

        case 'StarPiece':
            spawnGraph(name, SceneGraphTag.Normal, { btk: 'normal.btk', bck: 'land.bck' }).then(([node, rarc]) => {
                const animationController = new AnimationController();
                animationController.setTimeInFrames(objinfo.objArg3);

                const bpk = BPK.parse(assertExists(rarc.findFileData(`starpiececc.bpk`)));
                node.modelInstance.bindTRK1(bpk.pak1, animationController);
            });
            return;

        case 'SurfingRaceSubGate':
            spawnGraph(name).then(([node, rarc]) => {
                this.bindChangeAnimation(node, rarc, objinfo.objArg1);
            });
            return;

        // Bloomables.
        // The actual engine will search for a file suffixed "Bloom" and spawn it if so.
        // Here, we don't want to trigger that many HTTP requests, so we just list all
        // models with bloom variants explicitly.
        case 'AssemblyBlockPartsTimerA':
        case 'AstroDomeComet':
        case 'FlipPanel':
        case 'FlipPanelReverse':
        case 'HeavensDoorInsidePlanetPartsA':
        case 'LavaProminence':
        case 'LavaProminenceEnvironment':
        case 'LavaProminenceTriple':
        case 'PeachCastleTownBeforeAttack':
            spawnGraph(name, SceneGraphTag.Normal);
            spawnGraph(`${name}Bloom`, SceneGraphTag.Bloom);
            break;

        // SMG1.
        case 'AstroCore':
            spawnGraph(name, SceneGraphTag.Normal, { bck: 'revival4.bck', brk: 'revival4.brk', btk: 'astrocore.btk' });
            break;
        case 'AstroDomeEntrance': {
            switch (objinfo.objArg0) {
            case 1: spawnGraph('AstroDomeEntranceObservatory'); break;
            case 2: spawnGraph('AstroDomeEntranceWell'); break;
            case 3: spawnGraph('AstroDomeEntranceKitchen'); break;
            case 4: spawnGraph('AstroDomeEntranceBedRoom'); break;
            case 5: spawnGraph('AstroDomeEntranceMachine'); break;
            case 6: spawnGraph('AstroDomeEntranceTower'); break;
            default: assert(false);
            }
            break;
        }
        case 'AstroStarPlate': {
            switch (objinfo.objArg0) {
            case 1: spawnGraph('AstroStarPlateObservatory'); break;
            case 2: spawnGraph('AstroStarPlateWell'); break;
            case 3: spawnGraph('AstroStarPlateKitchen'); break;
            case 4: spawnGraph('AstroStarPlateBedRoom'); break;
            case 5: spawnGraph('AstroStarPlateMachine'); break;
            case 6: spawnGraph('AstroStarPlateTower'); break;
            default: assert(false);
            }
            break;
        }
        case 'SignBoard':
            // SignBoard has a single animation for falling over which we don't want to play.
            spawnGraph('SignBoard', SceneGraphTag.Normal, null);
            break;
        case 'Rabbit':
            spawnGraph('TrickRabbit');
            break;
        case 'Kinopio':
            spawnGraph('Kinopio', SceneGraphTag.Normal, { bck: 'wait.bck' });
            break;
        case 'Rosetta':
            spawnGraph(name, SceneGraphTag.Normal, { bck: 'waita.bck' }).then(([node, rarc]) => {
                // "Rosetta Encounter"
                this.nodeSetLightName(node, `ロゼッタ出会い`);
            });
            break;
        case 'Tico':
        case 'TicoAstro':
        case 'TicoRail':
            spawnGraph('Tico').then(([node, rarc]) => {
                this.bindChangeAnimation(node, rarc, objinfo.objArg0);
            });
            break;
        case 'TicoShop':
            spawnGraph(`TicoShop`).then(([node, rarc]) => {
                // TODO(jstpierre): Figure out what the deal is with the BVA not quite working...
                const bva = BVA.parse(rarc.findFileData(`Big1.bva`));
                node.modelInstance.bindVAF1(bva.vaf1, animFrame(0));
            });
            break;
        case 'BlackHole':
        case 'BlackHoleCube':
            spawnGraph(`BlackHole`);
            spawnGraph(`BlackHoleRange`).then(([node, rarc]) => {
                const scale = node.objinfo.objArg0 / 1000;
                mat4.scale(node.modelMatrix, node.modelMatrix, [scale, scale, scale]);
            });
            break;

        case 'SweetsDecoratePartsFork':
        case 'SweetsDecoratePartsSpoon':
            spawnGraph(name, SceneGraphTag.Normal, null).then(([node, rarc]) => {
                this.bindChangeAnimation(node, rarc, objinfo.objArg1);
            });
            break;
    
        case 'OtaKing':
            spawnGraph('OtaKing');
            spawnGraph('OtaKingMagma');
            spawnGraph('OtaKingMagmaBloom', SceneGraphTag.Bloom);
            break;

        case 'UFOKinoko':
            spawnGraph(name, SceneGraphTag.Normal, null).then(([node, rarc]) => {
                this.bindChangeAnimation(node, rarc, objinfo.objArg0);
            });
            break;
        case 'PlantA':
            spawnGraph(`PlantA00`);
            break;
        case 'PlantB':
            spawnGraph(`PlantB00`);
            break;
        case 'PlantC':
            spawnGraph(`PlantC00`);
            break;
        case 'PlantD':
            spawnGraph(`PlantD01`);
            break;
        case 'BenefitItemOneUp':
            spawnGraph(`KinokoOneUp`);
            break;
        case 'BenefitItemLifeUp':
            spawnGraph(`KinokoLifeUp`);
            break;
        case 'BenefitItemInvincible':
            spawnGraph(`PowerUpInvincible`);
            break;
        case 'MorphItemNeoHopper':
            spawnGraph(`PowerUpHopper`);
            break;
        case 'MorphItemNeoBee':
            spawnGraph(`PowerUpBee`);
            break;
        case 'MorphItemNeoFire':
            spawnGraph(`PowerUpFire`);
            break;
        case 'MorphItemNeoFoo':
            spawnGraph(`PowerUpFoo`);
            break;
        case 'MorphItemNeoIce':
            spawnGraph(`PowerUpIce`);
            break;
        case 'MorphItemNeoTeresa':
            spawnGraph(`PowerUpTeresa`);
            break;
        case 'SpinCloudItem':
            spawnGraph(`PowerUpCloud`);
            break;
        case 'PukupukuWaterSurface':
            spawnGraph(`Pukupuku`);
            break;
        case 'TreasureBoxEmpty':
        case 'TreasureBoxKinokoOneUp':
            spawnGraph(`TreasureBox`);
            break;
        case 'SuperSpinDriverPink':
            // TODO(jstpierre): Adjust color override.
            spawnGraph(`SuperSpinDriver`);
            break;
        case 'JetTurtle':
            spawnGraph(`Koura`);
            break;
    
        // TODO(jstpierre): Group spawn logic?
        case 'FishGroupA':
            spawnGraph(`FishA`);
            break;
        case 'FishGroupB':
            spawnGraph(`FishB`);
            break;
        case 'FishGroupC':
            spawnGraph(`FishC`);
            break;
        case 'SeaGullGroup':
            spawnGraph(`SeaGull`);
            break;

        case 'HeavensDoorAppearStepA':
            // This is the transition effect version of the steps that appear after you chase the bunnies in Gateway Galaxy.
            // "HeavensDoorAppearStepAAfter" is the non-transition version of the same, and it's also spawned, so don't
            // bother spawning this one.
            return;

        case 'GreenStar':
        case 'PowerStar':
            spawnGraph(`PowerStar`).then(([node, rarc]) => {
                if (this.isSMG1) {
                    // This appears to be hardcoded in the DOL itself, inside "GameEventFlagTable".
                    const isRedStar = node.objinfo.objArg0 === 2;
                    // This is also hardcoded, but the designers left us a clue.
                    const isGreenStar = name === 'GreenStar';
                    const frame = isRedStar ? 5 : isGreenStar ? 2 : 0;

                    const animationController = new AnimationController();
                    animationController.setTimeInFrames(frame);

                    const btp = BTP.parse(rarc.findFileData(`powerstar.btp`));
                    node.modelInstance.bindTPT1(btp.tpt1, animationController);
                }

                node.modelInstance.setMaterialVisible('Empty', false);
            });
            return;

        case 'GrandStar':
            spawnGraph(name).then(([node, rarc]) => {
                node.modelInstance.setMaterialVisible('GrandStarEmpty', false);
            });
            return;

        // SMG2
        case 'Moc':
            spawnGraph(name, SceneGraphTag.Normal, { bck: 'turn.bck' }).then(([node, rarc]) => {
                const bva = BVA.parse(rarc.findFileData(`FaceA.bva`));
                node.modelInstance.bindVAF1(bva.vaf1);
            });
            break;
        case 'CareTakerHunter':
            spawnGraph(`CaretakerHunter`);
            break;
        case 'WorldMapSyncSky':
            // Presumably this uses the "current world map". I chose 03, because I like it.
            spawnGraph(`WorldMap03Sky`, SceneGraphTag.Skybox);
            break;

        case 'DinoPackunVs1':
        case 'DinoPackunVs2':
            spawnGraph(`DinoPackun`);
            break;

        case 'Dodoryu':
            spawnGraph(name, SceneGraphTag.Normal, { bck: 'swoon.bck' });
            break;
        case 'Karikari':
            spawnGraph('Karipon');
            break;
        case 'YoshiCapture':
            spawnGraph(`YCaptureTarget`);
            break;
        case 'Patakuri':
            // TODO(jstpierre): Parent the wing to the kurib.
            spawnGraph(`Kuribo`, SceneGraphTag.Normal, { bck: 'patakuriwait.bck' });
            spawnGraph(`PatakuriWing`);
            break;
        case 'ShellfishCoin':
            spawnGraph(`Shellfish`);
            break;
        case 'TogeBegomanLauncher':
        case 'BegomanBabyLauncher':
            spawnGraph(`BegomanLauncher`);
            break;

        case 'MarioFacePlanetPrevious':
            // The "old" face planet that Lubba discovers. We don't want it in sight, just looks ugly.
            return;

        default:
            spawnDefault(name);
            break;
        }
    }

    public spawnZone(device: GfxDevice, zone: Zone, zones: Zone[], modelMatrixBase: mat4, parentLayer: number = -1): ZoneNode {
        // Spawn all layers. We'll hide them later when masking out the others.
        const zoneNode = new ZoneNode(zone, parentLayer);
        this.zones.push(zoneNode);

        for (const layer of zone.layers) {
            for (const objinfo of layer.objinfo)
                this.spawnObject(device, zoneNode, layer.index, objinfo, modelMatrixBase);

            for (const objinfo of layer.mappartsinfo)
                this.spawnObject(device, zoneNode, layer.index, objinfo, modelMatrixBase);

            for (const zoneinfo of layer.stageobjinfo) {
                const subzone = zones.find((zone) => zone.name === zoneinfo.objName);
                const subzoneModelMatrix = mat4.create();
                mat4.mul(subzoneModelMatrix, modelMatrixBase, zoneinfo.modelMatrix);
                const subzoneNode = this.spawnZone(device, subzone, zones, subzoneModelMatrix, layer.index);
                zoneNode.subzones.push(subzoneNode);
            }
        }

        return zoneNode;
    }

    public destroy(device: GfxDevice): void {
        this.modelCache.destroy(device);
        this.sceneGraph.destroy(device);
        this.textureHolder.destroy(device);
        this.viewRenderer.destroy(device);
        this.renderHelper.destroy(device);
    }
}

export abstract class SMGSceneDescBase implements Viewer.SceneDesc {
    protected pathBase: string;

    constructor(public name: string, public galaxyName: string, public id: string = galaxyName) {
    }

    protected abstract getZoneMapFilename(zoneName: string): string;
    protected abstract getLightDataFilename(): string;

    public parsePlacement(bcsv: BCSV.Bcsv, paths: Path[]): ObjInfo[] {
        return bcsv.records.map((record): ObjInfo => {
            const objId = BCSV.getField<number>(bcsv, record, 'l_id', -1);
            const objName = BCSV.getField<string>(bcsv, record, 'name', 'Unknown');
            const objArg0 = BCSV.getField<number>(bcsv, record, 'Obj_arg0', -1);
            const objArg1 = BCSV.getField<number>(bcsv, record, 'Obj_arg1', -1);
            const objArg2 = BCSV.getField<number>(bcsv, record, 'Obj_arg2', -1);
            const objArg3 = BCSV.getField<number>(bcsv, record, 'Obj_arg3', -1);
            const moveConditionType = BCSV.getField<number>(bcsv, record, 'MoveConditionType', 0);
            const rotateSpeed = BCSV.getField<number>(bcsv, record, 'RotateSpeed', 0);
            const rotateAccelType = BCSV.getField<number>(bcsv, record, 'RotateAccelType', 0);
            const rotateAxis = BCSV.getField<number>(bcsv, record, 'RotateAxis', 0);
            const pathId: number = BCSV.getField<number>(bcsv, record, 'CommonPath_ID', -1);
            const path = paths.find((path) => path.l_id === pathId) || null;
            const modelMatrix = mat4.create();
            computeModelMatrixFromRecord(modelMatrix, bcsv, record);
            return { objId, objName, objArg0, objArg1, objArg2, objArg3, moveConditionType, rotateSpeed, rotateAccelType, rotateAxis, modelMatrix, path };
        });
    }
    
    public parsePaths(pathDir: RARC.RARCDir): Path[] {
        const commonPathInfo = BCSV.parse(RARC.findFileDataInDir(pathDir, 'commonpathinfo'));
        return commonPathInfo.records.map((record, i): Path => {
            const l_id = BCSV.getField<number>(commonPathInfo, record, 'l_id');
            const no = BCSV.getField<number>(commonPathInfo, record, 'no');
            assert(no === i);
            const name = BCSV.getField<string>(commonPathInfo, record, 'name');
            const type = BCSV.getField<string>(commonPathInfo, record, 'type');
            const closed = BCSV.getField<string>(commonPathInfo, record, 'closed', 'OPEN');
            const path_arg0 = BCSV.getField<string>(commonPathInfo, record, 'path_arg0');
            const path_arg1 = BCSV.getField<string>(commonPathInfo, record, 'path_arg1');
            const pointinfo = BCSV.parse(RARC.findFileDataInDir(pathDir, `commonpathpointinfo.${i}`));
            const points = pointinfo.records.map((record, i) => {
                const id = BCSV.getField<number>(pointinfo, record, 'id');
                assert(id === i);
                const pnt0_x = BCSV.getField<number>(pointinfo, record, 'pnt0_x');
                const pnt0_y = BCSV.getField<number>(pointinfo, record, 'pnt0_y');
                const pnt0_z = BCSV.getField<number>(pointinfo, record, 'pnt0_z');
                const pnt1_x = BCSV.getField<number>(pointinfo, record, 'pnt1_x');
                const pnt1_y = BCSV.getField<number>(pointinfo, record, 'pnt1_y');
                const pnt1_z = BCSV.getField<number>(pointinfo, record, 'pnt1_z');
                const pnt2_x = BCSV.getField<number>(pointinfo, record, 'pnt2_x');
                const pnt2_y = BCSV.getField<number>(pointinfo, record, 'pnt2_y');
                const pnt2_z = BCSV.getField<number>(pointinfo, record, 'pnt2_z');
                const p0 = vec3.fromValues(pnt0_x, pnt0_y, pnt0_z);
                const p1 = vec3.fromValues(pnt1_x, pnt1_y, pnt1_z);
                const p2 = vec3.fromValues(pnt2_x, pnt2_y, pnt2_z);
                return { p0, p1, p2 };
            });
            return { l_id, name, type, closed, points };
        });
    }

    public parseZone(name: string, buffer: ArrayBufferSlice): Zone {
        const rarc = RARC.parse(buffer);
        const layers: ZoneLayer[] = [];
        for (let i = -1; i < 26; i++) {
            const layerName = getLayerName(i);
            const placementDir = `jmp/placement/${layerName}`;
            const pathDir = `jmp/path`;
            const mappartsDir = `jmp/mapparts/${layerName}`;
            if (!rarc.findDir(placementDir))
                continue;
            const paths = this.parsePaths(rarc.findDir(pathDir));
            const objinfo = this.parsePlacement(BCSV.parse(rarc.findFileData(`${placementDir}/objinfo`)), paths);
            const mappartsinfo = this.parsePlacement(BCSV.parse(rarc.findFileData(`${mappartsDir}/mappartsinfo`)), paths);
            const stageobjinfo = this.parsePlacement(BCSV.parse(rarc.findFileData(`${placementDir}/stageobjinfo`)), paths);
            layers.push({ index: i, objinfo, mappartsinfo, stageobjinfo });
        }
        return { name, layers };
    }

    public createScene(device: GfxDevice, abortSignal: AbortSignal): Progressable<Viewer.SceneGfx> {
        const galaxyName = this.galaxyName;
        return Progressable.all([
            fetchData(`${this.pathBase}/ObjectData/PlanetMapDataTable.arc`, abortSignal),
            fetchData(this.getLightDataFilename(), abortSignal),
            fetchData(`${this.pathBase}/StageData/${galaxyName}/${galaxyName}Scenario.arc`, abortSignal),
        ]).then((buffers: ArrayBufferSlice[]) => {
            return Promise.all(buffers.map((buffer) => Yaz0.decompress(buffer)));
        }).then((buffers: ArrayBufferSlice[]) => {
            const [planetTableBuffer, lightDataBuffer, scenarioBuffer] = buffers;

            // Load planet table.
            const planetTableRarc = RARC.parse(planetTableBuffer);
            const planetTable = BCSV.parse(planetTableRarc.findFileData('planetmapdatatable.bcsv'));

            // Load light data.
            const lightDataRarc = RARC.parse(lightDataBuffer);
            const lightData = BCSV.parse(lightDataRarc.findFileData('lightdata.bcsv'));

            // Load all the subzones.
            const scenarioRarc = RARC.parse(scenarioBuffer);
            const zonelist = BCSV.parse(scenarioRarc.findFileData('zonelist.bcsv'));
            const scenariodata = BCSV.parse(scenarioRarc.findFileData('scenariodata.bcsv'));

            // zonelist contains one field, ZoneName, a string
            assert(zonelist.fields.length === 1);
            assert(zonelist.fields[0].nameHash === BCSV.bcsvHashSMG('ZoneName'));
            const zoneNames = zonelist.records.map(([zoneName]) => zoneName as string);

            // The master zone is the first one.
            const masterZoneName = zoneNames[0];
            assert(masterZoneName === galaxyName);

            const renderHelper = new GXRenderHelperGfx(device);
            const viewRenderer = new GfxRenderInstViewRenderer();

            // Construct initial state.
            renderHelper.renderInstBuilder.constructRenderInsts(device, viewRenderer);

            return Progressable.all(zoneNames.map((zoneName) => fetchData(this.getZoneMapFilename(zoneName)))).then((buffers: ArrayBufferSlice[]) => {
                return Promise.all(buffers.map((buffer) => Yaz0.decompress(buffer)));
            }).then((zoneBuffers: ArrayBufferSlice[]): Viewer.SceneGfx => {
                const zones = zoneBuffers.map((zoneBuffer, i) => this.parseZone(zoneNames[i], zoneBuffer));
                const spawner = new SMGSpawner(this.pathBase, renderHelper, viewRenderer, planetTable, lightData);
                const modelMatrixBase = mat4.create();
                spawner.spawnZone(device, zones[0], zones, modelMatrixBase);
                return new SMGRenderer(device, spawner, viewRenderer, scenariodata, zoneNames);
            });
        });
    }
}